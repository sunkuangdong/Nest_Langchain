import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { AI_CHAIN, AI_MODEL, AI_PROMPT } from './ai.tokens';
import { tool } from '@langchain/core/tools';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';

const database = {
  users: {
    '001': {
      id: '001',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'admin',
    },
    '002': {
      id: '002',
      name: 'Bob',
      email: 'bob@example.com',
      role: 'user',
    },
    '003': {
      id: '003',
      name: 'Carol',
      email: 'carol@example.com',
      role: 'user',
    },
  },
};

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

const queryUserTool = tool(
  ({ userId }: QueryUserArgs) => {
    const user = database.users[userId as keyof typeof database.users];

    if (!user) {
      return `User ID ${userId} does not exist. Available IDs: 001, 002, 003`;
    }

    return `User info:\n- ID: ${user.id}\n- Name: ${user.name}\n- Email: ${user.email}\n- Role: ${user.role}`;
  },

  {
    name: 'query_user',
    description:
      'Look up a user in the database by ID. Returns name, email, and role.',
    schema: queryUserArgsSchema,
  },
);

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
  ) {
    this.modelWithTools = this.model.bindTools([queryUserTool]);
  }

  async runChain(query: string): Promise<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(
        'You are a helpful assistant. When needed, call tools (e.g. query_user) to fetch user data, then answer the user.',
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
          const result = await queryUserTool.invoke(args);

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
        'You are a helpful assistant. When needed, call tools (e.g. query_user) to fetch user data, then answer the user.',
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
          const args = queryUserArgsSchema.parse(toolCall.args);
          const result = await queryUserTool.invoke(args);

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
