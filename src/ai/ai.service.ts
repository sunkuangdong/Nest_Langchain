import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { AI_CHAIN, AI_MODEL, AI_PROMPT } from './ai.tokens';
import { tool } from '@langchain/core/tools';
import {
  AIMessage,
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

const queryUserArgsSchema = z.object({
  userId: z.string().describe('User ID, e.g. 001, 002, 003'),
});

type QueryUserArgs = {
  userId: string;
};

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

  async *streamChain(query: string): AsyncGenerator<string> {
    const stream = await this.chain.stream({ query });
    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
