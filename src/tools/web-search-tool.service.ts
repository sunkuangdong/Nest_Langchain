import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';

interface BochaWebPage {
  name?: string;
  url?: string;
  summary?: string;
  siteName?: string;
  siteIcon?: string;
  dateLastCrawled?: string;
}

interface BochaSearchResponse {
  code?: number | string;
  msg?: string;
  data?: {
    webPages?: {
      value?: BochaWebPage[];
    };
  };
}

@Injectable()
export class WebSearchToolService {
  readonly tool: DynamicStructuredTool;

  constructor(private readonly configService: ConfigService) {
    const webSearchArgsSchema = z.object({
      query: z.string().min(1).describe('Search query'),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of results, default 10'),
    });

    this.tool = tool(
      async ({ query, count }: { query: string; count?: number }) => {
        const apiKey = this.configService.get<string>('BOCHA_API_KEY');
        if (!apiKey) {
          return 'BOCHA_API_KEY is not configured on the server.';
        }

        const response = await fetch('https://api.bochaai.com/v1/web-search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query,
            freshness: 'noLimit',
            summary: true,
            count: count ?? 10,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return `Search API failed: ${response.status}, ${errorText}`;
        }

        let json: BochaSearchResponse;
        try {
          json = (await response.json()) as BochaSearchResponse;
        } catch (e) {
          return `Search response parse failed: ${(e as Error).message}`;
        }

        if (json.code !== 200 || !json.data) {
          return `Search API failed: ${json.msg ?? 'unknown error'}`;
        }

        const webpages = json.data.webPages?.value ?? [];
        if (!webpages.length) {
          return 'No results found.';
        }

        return webpages
          .map(
            (page, idx) =>
              `[${idx + 1}] ${page.name}\nURL: ${page.url}\nSummary: ${page.summary}\nSite: ${page.siteName}`,
          )
          .join('\n\n');
      },
      {
        name: 'web_search',
        description:
          'Search the web via Bocha API. Input query and optional count.',
        schema: webSearchArgsSchema,
      },
    );
  }
}
