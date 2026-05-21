import { Controller, Get, MessageEvent, Query, Sse } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AiService } from './ai.service';
import { JobAgentService } from './job-agent.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly jobAgentService: JobAgentService,
  ) {}

  @Get('chat')
  async chat(@Query('query') query: string) {
    const answer = await this.aiService.runChain(query);
    return { answer };
  }

  /** Dev: run JobAgentService once (same agent loop as scheduled job execution). */
  @Get('job-agent/run')
  async runJobAgent(@Query('instruction') instruction: string) {
    const result = await this.jobAgentService.runJob(instruction);
    return { result };
  }

  @Sse('chat/stream')
  chatStream(@Query('query') query: string): Observable<MessageEvent> {
    const stream = this.aiService.runChainStream(query);

    return from(stream).pipe(
      map((chunk) => ({
        data: chunk,
      })),
    );
  }
}
