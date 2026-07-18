import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MilvusRagService } from '../rag/milvus-rag.service';

@Injectable()
export class KnowledgeSearchToolService {
  readonly tool: DynamicStructuredTool;

  constructor(private readonly milvusRagService: MilvusRagService) {
    const knowledgeSearchArgsSchema = z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'Search query for the local knowledge base (RAG / documentation)',
        ),
      topK: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of chunks to return (default from RAG_TOP_K)'),
    });

    this.tool = tool(
      async ({ query, topK }: { query: string; topK?: number }) => {
        try {
          const hits = await this.milvusRagService.search(query, topK);
          return this.milvusRagService.formatHits(hits);
        } catch (e) {
          return `knowledge_search failed: ${(e as Error).message}`;
        }
      },
      {
        name: 'knowledge_search',
        description:
          'Search the local Milvus knowledge base (ingested docs under docs/rag-sample). Use for questions about LangChain, RAG, embeddings, Milvus, or other indexed documentation. Prefer this over web_search when the answer should come from local docs.',
        schema: knowledgeSearchArgsSchema,
      },
    );
  }
}
