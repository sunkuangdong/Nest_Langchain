import { Controller, Get, MessageEvent, Query, Res, Sse } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('chat')
  async chat(@Query('query') query: string) {
    const answer = await this.aiService.runChain(query);
    return { answer };
  }

  @Sse('chat/stream')
  stream(
    @Query('query') query: string,
    @Res({ passthrough: true }) res: Response,
  ): Observable<MessageEvent> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    return from(this.aiService.streamChain(query)).pipe(
      map((chunk) => ({ data: chunk })),
    );
  }
}
