import { Inject, Injectable } from '@nestjs/common';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import type { UIMessage } from 'ai';
import { createAgent, type ReactAgent } from 'langchain';
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
  KNOWLEDGE_SEARCH_TOOL,
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

const knowledgeSearchArgsSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional(),
});

type KnowledgeSearchArgs = z.infer<typeof knowledgeSearchArgsSchema>;

function parseKnowledgeSearchArgs(rawArgs: unknown): KnowledgeSearchArgs {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new Error('Invalid knowledge_search args JSON');
    }
  }
  return knowledgeSearchArgsSchema.parse(args);
}

const AGENT_SYSTEM_PROMPT = `You are an AI assistant with tool access. The following tools are wired on the server—do not claim you "cannot access the internet" or "cannot send email":
      1. knowledge_search: Search the local Milvus knowledge base (LangChain / RAG / embeddings docs). Prefer this over web_search for questions about RAG, LangChain retrieval, embeddings, or other indexed local documentation.
      2. web_search: Search the web for real-time information. When the user asks for latest news, trends, or facts to verify, call this first.
      3. send_mail: Send email. When the user asks to send to an email address, compose the content and call this tool.
      4. query_user: Look up mock local users by user ID (Three Kingdoms figures, IDs like 001).
      5. db_users_crud: CRUD on the MySQL users table (create/list/get/update/delete).
      6. cron_job: Manage server cron jobs (list/add/toggle). Call when the user wants scheduled reminders, periodic runs, or one-time execution.

      Rules:
      - For local-doc / RAG / LangChain questions, call knowledge_search first and ground your answer in the returned chunks.
      - If a tool returns an error, explain the API/configuration reason honestly (e.g. Bocha quota exceeded); do not revert to saying you cannot search yourself.
      - After a successful search, answer based on the results; if the user wants HTML email, send it with send_mail.
      - In multi-turn chat, use prior context: remember names, corrections, and preferences; do not treat user self-introduction as a third party to search; avoid re-greeting every turn.`;

export type ChatHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

const MAX_CHAT_HISTORY = 20;
const MAX_TTS_BUFFER_WITHOUT_PUNCT = 80;

type RunChainStreamOptions = {
  ttsSessionId?: string;
};

/** LangChain stream chunk.content may be a string or a content-block array. */
function extractStreamText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (part && typeof part === 'object') {
      const block = part as Record<string, unknown>;
      if (typeof block.text === 'string') text += block.text;
      else if (typeof block.content === 'string') text += block.content;
    }
  }
  return text;
}

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
  private readonly aguiAgent: ReactAgent;

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
    @Inject(KNOWLEDGE_SEARCH_TOOL)
    private readonly knowledgeSearchTool: StructuredToolInterface<
      typeof knowledgeSearchArgsSchema,
      KnowledgeSearchArgs,
      string
    >,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.modelWithTools = this.model.bindTools([
      this.knowledgeSearchTool,
      this.queryUserTool,
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
      this.cronJobTool,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    this.aguiAgent = createAgent({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      model: this.model as any,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      tools: [
        this.knowledgeSearchTool,
        this.queryUserTool,
        this.sendMailTool,
        this.webSearchTool,
        this.dbUsersCrudTool,
        this.cronJobTool,
      ] as any,
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });
  }

  /** AGUI / Data Stream: LangChain agent → AI SDK UIMessage stream. */
  async stream(messages: UIMessage[]) {
    const lcMessages = await toBaseMessages(messages);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const lgStream = await this.aguiAgent.stream(
      { messages: lcMessages },
      { streamMode: ['messages', 'values'], recursionLimit: 12 },
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return toUIMessageStream(lgStream as any);
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
        } else if (toolName === 'knowledge_search') {
          const args = parseKnowledgeSearchArgs(toolCall.args);
          const result = await this.knowledgeSearchTool.invoke(args);

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
    /** Chars already fed from stream chunks into TTS (avoids duplicate segments vs fullMessage). */
    let ttsFedLength = 0;

    const emitTtsEvent = (event: AiTtsStreamEvent) => {
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
          const textChunk = extractStreamText(chunk.content);
          if (!hasToolCallChunk && textChunk) {
            yield textChunk;
            if (ttsSessionId) {
              ttsTextBuffer += textChunk;
              ttsFedLength += textChunk.length;
              flushTts(false);
            }
          }
        }

        if (ttsSessionId && fullAIMessage) {
          const fullText = extractStreamText(fullAIMessage.content);
          if (fullText.length > ttsFedLength) {
            ttsTextBuffer += fullText.slice(ttsFedLength);
            ttsFedLength = fullText.length;
            flushTts(false);
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

      if (toolCalls.length && ttsSessionId) {
        flushTts(true);
      }

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
        } else if (toolName === 'knowledge_search') {
          const args = parseKnowledgeSearchArgs(toolCall.args);
          const result = await this.knowledgeSearchTool.invoke(args);

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
