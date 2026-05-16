import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';

@Injectable()
export class AiService {
  private readonly chain: Runnable<{ query: string }, string>;
  private readonly model: ChatOpenAI;
  private readonly prompt: PromptTemplate<{ query: string }>;

  constructor(private readonly configService: ConfigService) {
    this.prompt = PromptTemplate.fromTemplate('请回答以下问题：\n\n{query}');
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');
    const baseURL = this.configService.getOrThrow<string>('OPENAI_BASE_URL');
    const modelName =
      this.configService.get<string>('MODEL_NAME') ?? 'qwen-plus';

    this.model = new ChatOpenAI({
      temperature: 0.7,
      modelName,
      apiKey,
      configuration: {
        baseURL,
      },
    });
    this.chain = this.prompt.pipe(this.model).pipe(new StringOutputParser());
  }

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
