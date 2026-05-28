import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import {
  AI_CHAIN,
  AI_MODEL,
  AI_PROMPT,
  QUERY_USER_TOOL,
  SEND_MAIL_TOOL,
  WEB_SEARCH_TOOL,
  DB_USERS_CRUD_TOOL,
  CRON_JOB_TOOL,
} from './ai.tokens';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AI_TTS_STREAM_EVENT,
  type AiTtsStreamEvent,
} from '../common/stream-events';

function normalizeUserId(userId: string): string {
  const trimmed = userId.trim();
  if (/^\d+$/.test(trimmed) && trimmed.length < 3) {
    return trimmed.padStart(3, '0');
  }
  return trimmed;
}

const queryUserArgsSchema = z.object({
  userId: z.coerce
    .string()
    .transform((id) => normalizeUserId(id))
    .describe('User ID, e.g. 001, 002, 003'),
});

type QueryUserArgs = {
  userId: string;
};

function parseQueryUserArgs(rawArgs: unknown): QueryUserArgs {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      args = { userId: args };
    }
  }
  return queryUserArgsSchema.parse(args);
}

const sendMailArgsSchema = z.object({
  to: z.email(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
});

const webSearchArgsSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(20).optional(),
});

type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

type SendMailArgs = z.infer<typeof sendMailArgsSchema>;

const dbUsersCrudArgsSchema = z.object({
  action: z.enum(['create', 'list', 'get', 'update', 'delete']),
  id: z.number().int().positive().optional(),
  name: z.string().min(1).max(50).optional(),
  email: z.string().email().max(50).optional(),
});

type DbUsersCrudArgs = z.infer<typeof dbUsersCrudArgsSchema>;

function parseDbUsersCrudArgs(rawArgs: unknown): DbUsersCrudArgs {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new Error('Invalid db_users_crud args JSON');
    }
  }
  return dbUsersCrudArgsSchema.parse(args);
}

function parseWebSearchArgs(rawArgs: unknown): WebSearchArgs {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new Error('Invalid web_search args JSON');
    }
  }
  return webSearchArgsSchema.parse(args);
}

const cronJobArgsSchema = z.object({
  action: z.enum(['list', 'add', 'toggle']),
  id: z.string().optional(),
  enabled: z.boolean().optional(),
  type: z.enum(['cron', 'every', 'at']).optional(),
  instruction: z.string().optional(),
  cron: z.string().optional(),
  everyMs: z.number().int().positive().optional(),
  at: z.string().optional(),
});

type CronJobArgs = z.infer<typeof cronJobArgsSchema>;

function parseCronJobArgs(rawArgs: unknown): CronJobArgs {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new Error('Invalid cron_job args JSON');
    }
  }
  return cronJobArgsSchema.parse(args);
}

const AGENT_SYSTEM_PROMPT = `你是具备工具能力的 AI 助手，已通过服务端接入以下工具，禁止声称「无法联网」「无法发邮件」：
      1. web_search：检索互联网实时信息。用户问最新资讯、新闻、趋势、需查证的事实时，必须先调用。
      2. send_mail：发送邮件。用户要求发到某邮箱时，整理内容后调用。
      3. query_user：按用户 ID 查询本地假数据用户（三国人物，ID 如 001）。
      4. db_users_crud：对 MySQL users 表增删改查（create/list/get/update/delete）。
      5. cron_job：管理服务端定时任务（list/add/toggle）。用户要定时提醒、周期执行、指定时间执行一次时调用。

      规则：
      - 工具返回错误时，向用户如实说明 API/配置原因（如博查配额不足），不要改口说你自己不能搜索。
      - 搜索成功后，基于结果整理回答；用户要求发 HTML 邮件时，用 send_mail 发送。
      - 多轮对话时务必结合上文：记住用户已提供的姓名、纠正与偏好；不要把用户自我介绍当成要检索的第三方；不要每轮都重新寒暄。`;

export type ChatHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

const MAX_CHAT_HISTORY = 20;
const MAX_TTS_BUFFER_WITHOUT_PUNCT = 80;

type RunChainStreamOptions = {
  ttsSessionId?: string;
};

function splitReadyTtsSegments(
  rawBuffer: string,
  forceFlush: boolean,
): { segments: string[]; rest: string } {
  const segments: string[] = [];
  let rest = rawBuffer;

  const sentenceEndRegex = /[。！？!?；;：:\n]/;
  let match = sentenceEndRegex.exec(rest);
  while (match) {
    const end = (match.index ?? 0) + 1;
    const segment = rest.slice(0, end).trim();
    if (segment) {
      segments.push(segment);
    }
    rest = rest.slice(end);
    match = sentenceEndRegex.exec(rest);
  }

  if (!forceFlush && rest.trim().length >= MAX_TTS_BUFFER_WITHOUT_PUNCT) {
    segments.push(rest.trim());
    rest = '';
  }

  if (forceFlush) {
    const finalSegment = rest.trim();
    if (finalSegment) {
      segments.push(finalSegment);
    }
    rest = '';
  }

  return { segments, rest };
}

function parseSendMailArgs(rawArgs: unknown): SendMailArgs {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new Error('Invalid send_mail args JSON');
    }
  }
  return sendMailArgsSchema.parse(args);
}

@Injectable()
export class AiService {
  private readonly modelWithTools: Runnable<BaseMessage[], AIMessage>;

  constructor(
    @Inject(AI_CHAIN)
    private readonly chain: Runnable<{ query: string }, string>,
    @Inject(AI_MODEL)
    private readonly model: ChatOpenAI,
    @Inject(AI_PROMPT)
    private readonly prompt: PromptTemplate<{ query: string }>,
    @Inject(QUERY_USER_TOOL)
    private readonly queryUserTool: StructuredToolInterface<
      typeof queryUserArgsSchema,
      QueryUserArgs,
      string
    >,
    @Inject(SEND_MAIL_TOOL)
    private readonly sendMailTool: StructuredToolInterface<
      typeof sendMailArgsSchema,
      SendMailArgs,
      string
    >,
    @Inject(WEB_SEARCH_TOOL)
    private readonly webSearchTool: StructuredToolInterface<
      typeof webSearchArgsSchema,
      WebSearchArgs,
      string
    >,
    @Inject(DB_USERS_CRUD_TOOL)
    private readonly dbUsersCrudTool: StructuredToolInterface<
      typeof dbUsersCrudArgsSchema,
      DbUsersCrudArgs,
      string
    >,
    @Inject(CRON_JOB_TOOL)
    private readonly cronJobTool: StructuredToolInterface<
      typeof cronJobArgsSchema,
      CronJobArgs,
      string
    >,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.modelWithTools = this.model.bindTools([
      this.queryUserTool,
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
      this.cronJobTool,
    ]);
  }

  private buildAgentMessages(
    query: string,
    history: ChatHistoryItem[] = [],
  ): BaseMessage[] {
    const messages: BaseMessage[] = [new SystemMessage(AGENT_SYSTEM_PROMPT)];
    const recent = history.slice(-MAX_CHAT_HISTORY);

    for (const item of recent) {
      if (item.role === 'user') {
        messages.push(new HumanMessage(item.content));
      } else {
        messages.push(new AIMessage(item.content));
      }
    }

    messages.push(new HumanMessage(query));
    return messages;
  }

  async runChain(
    query: string,
    history: ChatHistoryItem[] = [],
  ): Promise<string> {
    const messages = this.buildAgentMessages(query, history);

    while (true) {
      const aiMessage = await this.modelWithTools.invoke(messages);
      messages.push(aiMessage);

      const toolCalls = aiMessage.tool_calls ?? [];

      // No tool calls: return the model reply
      if (!toolCalls.length) {
        return aiMessage.content as string;
      }

      // Run each tool call from this turn
      for (const toolCall of toolCalls) {
        const toolCallId = toolCall.id || '';
        const toolName = toolCall.name;

        if (toolName === 'query_user') {
          const args = parseQueryUserArgs(toolCall.args);
          const result = await this.queryUserTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'send_mail') {
          const args = parseSendMailArgs(toolCall.args);
          const result = await this.sendMailTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'web_search') {
          const args = parseWebSearchArgs(toolCall.args);
          const result = await this.webSearchTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'db_users_crud') {
          const args = parseDbUsersCrudArgs(toolCall.args);
          const result = await this.dbUsersCrudTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'cron_job') {
          const args = parseCronJobArgs(toolCall.args);
          console.log('[cron_job] args:', args);
          const result = await this.cronJobTool.invoke(args);
          console.log('[cron_job] result:', result);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        }
      }
    }
  }

  async *runChainStream(
    query: string,
    history: ChatHistoryItem[] = [],
    options: RunChainStreamOptions = {},
  ): AsyncIterable<string> {
    const messages = this.buildAgentMessages(query, history);
    const ttsSessionId = options.ttsSessionId?.trim();
    let ttsTextBuffer = '';

    const emitTtsEvent = (event: AiTtsStreamEvent) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, event);
    };
    const flushTts = (forceFlush: boolean) => {
      if (!ttsSessionId) return;
      const { segments, rest } = splitReadyTtsSegments(
        ttsTextBuffer,
        forceFlush,
      );
      ttsTextBuffer = rest;
      for (const segment of segments) {
        emitTtsEvent({
          type: 'chunk',
          sessionId: ttsSessionId,
          chunk: segment,
        });
      }
    };

    if (ttsSessionId) {
      emitTtsEvent({
        type: 'start',
        sessionId: ttsSessionId,
        query,
      });
    }

    while (true) {
      // One turn: model may reason and optionally request tool calls
      const stream = await this.modelWithTools.stream(messages);

      let fullAIMessage: AIMessageChunk | null = null;
      try {
        for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
          // Merge chunks with concat to build the full AIMessageChunk for this turn
          fullAIMessage = fullAIMessage ? fullAIMessage.concat(chunk) : chunk;

          const hasToolCallChunk =
            !!fullAIMessage.tool_call_chunks &&
            fullAIMessage.tool_call_chunks.length > 0;

          // Stream text only until tool-call chunks appear in this turn
          if (!hasToolCallChunk && chunk.content) {
            const textChunk = chunk.content as string;
            yield textChunk;
            if (ttsSessionId) {
              ttsTextBuffer += textChunk;
              flushTts(false);
            }
          }
        }
      } catch (e) {
        if (ttsSessionId) {
          emitTtsEvent({
            type: 'error',
            sessionId: ttsSessionId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        console.error('for await failed before yielding next chunk');
        console.error(e);
        console.error(e instanceof Error ? e.stack : e);
        throw e;
      }

      if (!fullAIMessage) {
        return;
      }

      messages.push(fullAIMessage);

      const toolCalls = fullAIMessage.tool_calls ?? [];

      // No tool calls: final answer was already streamed above; done
      if (!toolCalls.length) {
        if (ttsSessionId) {
          flushTts(true);
          emitTtsEvent({
            type: 'end',
            sessionId: ttsSessionId,
          });
        }
        return;
      }

      // Tool calls: run tools, append ToolMessage, then start the next turn
      for (const toolCall of toolCalls) {
        const toolCallId = toolCall.id || '';
        const toolName = toolCall.name;

        if (toolName === 'query_user') {
          const args = parseQueryUserArgs(toolCall.args);
          const result = await this.queryUserTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'send_mail') {
          const args = parseSendMailArgs(toolCall.args);
          const result = await this.sendMailTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'web_search') {
          const args = parseWebSearchArgs(toolCall.args);
          const result = await this.webSearchTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'db_users_crud') {
          const args = parseDbUsersCrudArgs(toolCall.args);
          const result = await this.dbUsersCrudTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'cron_job') {
          const args = parseCronJobArgs(toolCall.args);
          const result = await this.cronJobTool.invoke(args);

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        }
      }
    }
  }
}
