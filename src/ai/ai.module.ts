import { Module } from '@nestjs/common';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOpenAI } from '@langchain/openai';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { JobAgentService } from './job-agent.service';
import { AI_CHAIN, AI_MODEL, AI_PROMPT } from './ai.tokens';
import { ToolModule } from '../tools/tool.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ToolModule, UsersModule],
  controllers: [AiController],
  providers: [
    {
      provide: AI_PROMPT,
      useFactory: () =>
        PromptTemplate.fromTemplate(
          'Please answer the following question:\n\n{query}',
        ),
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
    JobAgentService,
  ],
  exports: [JobAgentService],
})
export class AiModule {}
