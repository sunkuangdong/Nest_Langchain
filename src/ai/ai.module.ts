import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOpenAI } from '@langchain/openai';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AI_CHAIN, AI_MODEL, AI_PROMPT } from './ai.tokens';

@Module({
  controllers: [AiController],
  providers: [
    {
      provide: AI_PROMPT,
      useFactory: () =>
        PromptTemplate.fromTemplate('请回答以下问题：\n\n{query}'),
    },
    {
      provide: AI_MODEL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const apiKey = configService.getOrThrow<string>('OPENAI_API_KEY');
        const baseURL = configService.getOrThrow<string>('OPENAI_BASE_URL');
        const modelName =
          configService.get<string>('MODEL_NAME') ?? 'qwen-plus';

        return new ChatOpenAI({
          temperature: 0.7,
          modelName,
          apiKey,
          configuration: { baseURL },
        });
      },
    },
    {
      provide: AI_CHAIN,
      inject: [AI_PROMPT, AI_MODEL],
      useFactory: (
        prompt: PromptTemplate<{ query: string }>,
        model: ChatOpenAI,
      ) => prompt.pipe(model).pipe(new StringOutputParser()),
    },
    AiService,
  ],
})
export class AiModule {}
