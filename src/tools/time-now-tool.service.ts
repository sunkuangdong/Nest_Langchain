import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';

@Injectable()
export class TimeNowToolService {
  readonly tool: DynamicStructuredTool;

  constructor() {
    this.tool = tool(
      () => {
        const now = new Date();
        return JSON.stringify({
          iso: now.toISOString(),
          timestamp: now.getTime(),
        });
      },
      {
        name: 'time_now',
        description:
          'Return server time as JSON string with iso and timestamp fields.',
        schema: z.object({}),
      },
    );
  }
}
