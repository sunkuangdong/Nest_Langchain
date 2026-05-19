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

const AGENT_SYSTEM_PROMPT = `你是具备工具能力的 AI 助手，已通过服务端接入以下工具，禁止声称「无法联网」「无法发邮件」：
      1. web_search：检索互联网实时信息。用户问最新资讯、新闻、趋势、需查证的事实时，必须先调用。
      2. send_mail：发送邮件。用户要求发到某邮箱时，整理内容后调用。
      3. query_user：按用户 ID 查询本地假数据用户（三国人物，ID 如 001）。
      4. db_users_crud：对 MySQL users 表增删改查（create/list/get/update/delete）。

      规则：
      - 工具返回错误时，向用户如实说明 API/配置原因（如博查配额不足），不要改口说你自己不能搜索。
      - 搜索成功后，基于结果整理回答；用户要求发 HTML 邮件时，用 send_mail 发送。`;

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
  ) {
    this.modelWithTools = this.model.bindTools([
      this.queryUserTool,
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
    ]);
  }

  async runChain(query: string): Promise<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(AGENT_SYSTEM_PROMPT),
      new HumanMessage(query),
    ];

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
        }
      }
    }
  }

  async *runChainStream(query: string): AsyncIterable<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(AGENT_SYSTEM_PROMPT),
      new HumanMessage(query),
    ];

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
            yield chunk.content as string;
          }
        }
      } catch (e) {
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
        }
      }
    }
  }
}
