import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

@Injectable()
export class LlmService {
  constructor(private readonly configService: ConfigService) {}

  getModel() {
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');
    const baseURL = this.configService.getOrThrow<string>('OPENAI_BASE_URL');
    const modelName =
      this.configService.get<string>('MODEL_NAME') ?? 'qwen-plus';

    return new ChatOpenAI({
      temperature: 0.7,
      modelName,
      apiKey,
      configuration: { baseURL },
    });
  }
}
