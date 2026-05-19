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

type SendMailArgs = z.infer<typeof sendMailArgsSchema>;

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
  ) {
    this.modelWithTools = this.model.bindTools([
      this.queryUserTool,
      this.sendMailTool,
    ]);
  }

  async runChain(query: string): Promise<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(
        'You are a helpful assistant. When needed, call tools (e.g. query_user, send_mail) to fetch user data or send email, then answer the user.',
      ),
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
        }
      }
    }
  }

  async *runChainStream(query: string): AsyncIterable<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(
        'You are a helpful assistant. When needed, call tools (e.g. query_user, send_mail) to fetch user data or send email, then answer the user.',
      ),
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
        }
      }
    }
  }
}
