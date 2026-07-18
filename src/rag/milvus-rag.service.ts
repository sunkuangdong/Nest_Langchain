import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

export type RagHit = {
  text: string;
  source: string;
  chunkIndex: number;
  score: number;
};

@Injectable()
export class MilvusRagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MilvusRagService.name);
  private client: MilvusClient | null = null;
  private ready = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.connect();
      await this.ensureLoaded();
      this.ready = true;
      this.logger.log(
        `Milvus RAG ready: ${this.getAddress()} / ${this.getCollection()}`,
      );
    } catch (err) {
      this.ready = false;
      this.logger.warn(
        `Milvus RAG not ready (knowledge_search will fail until Milvus is up): ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.closeConnection();
      this.client = null;
    }
  }

  isReady(): boolean {
    return this.ready && this.client != null;
  }

  async search(query: string, topK?: number): Promise<RagHit[]> {
    if (!this.client) {
      this.connect();
    }
    if (!this.client) {
      throw new Error('Milvus client is not connected');
    }

    await this.ensureLoaded();

    const k = topK ?? this.getTopK();
    const [vector] = await this.embedTexts([query]);

    const result = await this.client.search({
      collection_name: this.getCollection(),
      data: [vector],
      limit: k,
      output_fields: ['text', 'source', 'chunk_index'],
      metric_type: 'COSINE',
      params: { nprobe: 10 },
    });

    const rows = this.normalizeSearchRows(result);
    return rows.map((row) => ({
      text: this.asString(row.text),
      source: this.asString(row.source),
      chunkIndex: Number(row.chunk_index ?? 0),
      score: Number(row.score ?? row.distance ?? 0),
    }));
  }

  formatHits(hits: RagHit[]): string {
    if (!hits.length) {
      return 'No relevant documents found in the knowledge base.';
    }
    return hits
      .map(
        (hit, idx) =>
          `[${idx + 1}] source=${hit.source} chunk=${hit.chunkIndex} score=${hit.score.toFixed(4)}\n${hit.text}`,
      )
      .join('\n\n');
  }

  private getAddress(): string {
    return (
      this.configService.get<string>('MILVUS_ADDRESS') ?? 'localhost:19530'
    );
  }

  private getCollection(): string {
    return this.configService.get<string>('MILVUS_COLLECTION') ?? 'rag_docs';
  }

  private getTopK(): number {
    const raw = this.configService.get<string>('RAG_TOP_K');
    const n = raw ? Number(raw) : 4;
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 4;
  }

  private getEmbeddingModel(): string {
    const configured = this.configService.get<string>('EMBEDDING_MODEL');
    if (configured) return configured;
    const baseURL = (
      this.configService.get<string>('OPENAI_BASE_URL') ??
      'https://api.openai.com/v1'
    ).toLowerCase();
    if (baseURL.includes('dashscope') || baseURL.includes('aliyuncs.com')) {
      return 'text-embedding-v3';
    }
    return 'text-embedding-3-small';
  }

  private connect(): void {
    if (this.client) return;

    const address = this.getAddress();
    const username = this.configService.get<string>('MILVUS_USER');
    const password = this.configService.get<string>('MILVUS_PASSWORD') ?? '';

    const config: { address: string; username?: string; password?: string } = {
      address,
    };
    if (username) {
      config.username = username;
      config.password = password;
    }

    this.client = new MilvusClient(config);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.client) return;
    const collection = this.getCollection();
    const has = await this.client.hasCollection({
      collection_name: collection,
    });
    const exists = has?.value === true;
    if (!exists) {
      throw new Error(
        `Milvus collection "${collection}" does not exist. Run: pnpm run rag:ingest:recreate`,
      );
    }
    await this.client.loadCollection({ collection_name: collection });
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    const baseURL = (
      this.configService.get<string>('OPENAI_BASE_URL') ??
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');

    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.getEmbeddingModel(),
        input: texts,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Embedding API failed (${response.status}): ${errText}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding: number[]; index?: number }>;
    };
    const data = Array.isArray(json.data) ? json.data : [];
    if (data.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${data.length}`,
      );
    }
    return data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding);
  }

  private asString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return '';
  }

  private normalizeSearchRows(result: unknown): Array<Record<string, unknown>> {
    if (!result || typeof result !== 'object') return [];
    const r = result as Record<string, unknown>;

    // SDK may return { results: [...] } or { results: [[{...}]] }
    const results = r.results;
    if (Array.isArray(results)) {
      if (results.length && Array.isArray(results[0])) {
        return (results[0] as unknown[]).filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === 'object',
        );
      }
      return results.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object',
      );
    }

    return [];
  }
}
