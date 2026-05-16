import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { AI_CHAIN, AI_MODEL, AI_PROMPT } from './ai.tokens';

@Injectable()
export class AiService {
  constructor(
    @Inject(AI_CHAIN)
    private readonly chain: Runnable<{ query: string }, string>,
    @Inject(AI_MODEL)
    private readonly model: ChatOpenAI,
    @Inject(AI_PROMPT)
    private readonly prompt: PromptTemplate<{ query: string }>,
  ) {}

  async runChain(query: string): Promise<string> {
    return this.chain.invoke({ query });
  }

  async *streamChain(query: string): AsyncGenerator<string> {
    const stream = await this.chain.stream({ query });
    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
