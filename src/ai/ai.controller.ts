import {
  Body,
  Controller,
  Get,
  MessageEvent,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AiService, type ChatHistoryItem } from './ai.service';
import { JobAgentService } from './job-agent.service';

type ChatStreamBody = {
  query: string;
  history?: ChatHistoryItem[];
};

function isChatHistoryItem(item: unknown): item is ChatHistoryItem {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const record = item as Record<string, unknown>;
  return (
    (record.role === 'user' || record.role === 'assistant') &&
    typeof record.content === 'string'
  );
}

function parseHistoryJson(raw?: string): ChatHistoryItem[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isChatHistoryItem);
  } catch {
    return [];
  }
}

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly jobAgentService: JobAgentService,
  ) {}

  @Get('chat')
  async chat(
    @Query('query') query: string,
    @Query('history') historyJson?: string,
  ) {
    const history = parseHistoryJson(historyJson);
    const answer = await this.aiService.runChain(query, history);
    return { answer };
  }

  /** Dev: run JobAgentService once (same agent loop as scheduled job execution). */
  @Get('job-agent/run')
  async runJobAgent(@Query('instruction') instruction: string) {
    const result = await this.jobAgentService.runJob(instruction);
    return { result };
  }

  @Sse('chat/stream')
  chatStream(
    @Query('query') query: string,
    @Query('history') historyJson?: string,
  ): Observable<MessageEvent> {
    const history = parseHistoryJson(historyJson);
    const stream = this.aiService.runChainStream(query, history);

    return from(stream).pipe(
      map((chunk) => ({
        data: chunk,
      })),
    );
  }

  @Post('chat/stream')
  @Sse()
  chatStreamPost(@Body() body: ChatStreamBody): Observable<MessageEvent> {
    const history = Array.isArray(body.history) ? body.history : [];
    const stream = this.aiService.runChainStream(body.query ?? '', history);

    return from(stream).pipe(
      map((chunk) => ({
        data: chunk,
      })),
    );
  }
}
