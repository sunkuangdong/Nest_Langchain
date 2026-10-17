import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { sanitizeEndpoint } from './runtime-config.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const EVAL_COLLECTION_PREFIX = 'rag_docs_eval_';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function assertEvaluationCollection(collection) {
  if (!/^[a-z0-9_]+$/.test(collection)) {
    throw new Error(
      'EVAL_MILVUS_COLLECTION must contain only lowercase letters, numbers, and underscores',
    );
  }
  if (!collection.startsWith(EVAL_COLLECTION_PREFIX)) {
    throw new Error(
      `Refusing to use non-evaluation collection "${collection}"; name must start with "${EVAL_COLLECTION_PREFIX}"`,
    );
  }
}

export function getRagEvaluationConfig(root) {
  const rawBaseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).trim();
  const modelBaseUrl = sanitizeEndpoint(rawBaseUrl, DEFAULT_BASE_URL);
  const collection = (
    process.env.EVAL_MILVUS_COLLECTION || 'rag_docs_eval_v1'
  ).trim();
  assertEvaluationCollection(collection);

  const chunkSize = positiveInteger(
    process.env.EVAL_RAG_CHUNK_SIZE,
    800,
    'EVAL_RAG_CHUNK_SIZE',
  );
  const chunkOverlap = Number(process.env.EVAL_RAG_CHUNK_OVERLAP ?? 120);
  if (
    !Number.isInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    throw new Error(
      'EVAL_RAG_CHUNK_OVERLAP must be an integer from 0 to chunk size - 1',
    );
  }

  const docsPath = path.join(root, 'docs/rag-sample');
  return {
    raw_base_url: rawBaseUrl.replace(/\/$/, ''),
    model_base_url: modelBaseUrl,
    embedding_model:
      process.env.EMBEDDING_MODEL ||
      (modelBaseUrl.includes('dashscope') ||
      modelBaseUrl.includes('aliyuncs.com')
        ? 'text-embedding-v3'
        : 'text-embedding-3-small'),
    embedding_dimensions: process.env.EMBEDDING_DIMENSIONS
      ? positiveInteger(
          process.env.EMBEDDING_DIMENSIONS,
          undefined,
          'EMBEDDING_DIMENSIONS',
        )
      : null,
    embedding_batch: positiveInteger(
      process.env.EVAL_RAG_EMBED_BATCH,
      16,
      'EVAL_RAG_EMBED_BATCH',
    ),
    timeout_seconds: positiveInteger(
      process.env.EVAL_TIMEOUT_SECONDS,
      120,
      'EVAL_TIMEOUT_SECONDS',
    ),
    max_provider_retries: Number(process.env.MODEL_MAX_RETRIES ?? 2),
    milvus_address: process.env.MILVUS_ADDRESS || 'localhost:19530',
    collection,
    docs_path: docsPath,
    docs_path_relative: path.relative(root, docsPath),
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    top_k: positiveInteger(process.env.EVAL_RAG_TOP_K, 5, 'EVAL_RAG_TOP_K'),
    metric: 'COSINE',
    concurrency: 1,
  };
}

export function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Evaluation corpus not found: ${directory}`);
  }
  const files = [];
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    const stat = fs.statSync(filename);
    if (stat.isDirectory()) files.push(...listMarkdownFiles(filename));
    else if (
      name.toLowerCase().endsWith('.md') &&
      name.toLowerCase() !== 'readme.md'
    ) {
      files.push(filename);
    }
  }
  return files.sort();
}

export function chunkText(text, size, overlap) {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= size) return [cleaned];

  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(start + size, cleaned.length);
    if (end < cleaned.length) {
      const window = cleaned.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf(' '),
      );
      if (breakAt > size * 0.4) end = start + breakAt;
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= cleaned.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function buildCorpusSnapshot(root, config) {
  const files = listMarkdownFiles(config.docs_path);
  const manifest = files.map((filename) => {
    const content = fs.readFileSync(filename, 'utf8');
    return {
      path: path.relative(root, filename),
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
    };
  });
  const chunks = [];
  for (const filename of files) {
    const source = path.relative(root, filename);
    const parts = chunkText(
      fs.readFileSync(filename, 'utf8'),
      config.chunk_size,
      config.chunk_overlap,
    );
    for (const [chunkIndex, text] of parts.entries()) {
      chunks.push({
        source,
        chunk_index: chunkIndex,
        text: text.slice(0, 8000),
      });
    }
  }
  if (!files.length || !chunks.length) {
    throw new Error('Fixed evaluation corpus produced no chunks');
  }
  return {
    manifest,
    corpus_sha256: sha256(JSON.stringify(manifest)),
    chunks_sha256: sha256(
      JSON.stringify(
        chunks.map((chunk) => ({
          source: chunk.source,
          chunk_index: chunk.chunk_index,
          text_sha256: sha256(chunk.text),
        })),
      ),
    ),
    chunks,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function embedTexts(texts, config, apiKey) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  let lastError;
  for (let attempt = 0; attempt <= config.max_provider_retries; attempt += 1) {
    try {
      const response = await fetch(`${config.raw_base_url}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.embedding_model,
          input: texts,
        }),
        signal: AbortSignal.timeout(config.timeout_seconds * 1000),
      });
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(
          `Embedding API failed (${response.status}): ${body.slice(0, 500)}`,
        );
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } else {
        const json = await response.json();
        const data = Array.isArray(json.data) ? json.data : [];
        if (data.length !== texts.length) {
          throw new Error(
            `Embedding count mismatch: expected ${texts.length}, got ${data.length}`,
          );
        }
        return {
          vectors: data
            .slice()
            .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
            .map((item) => item.embedding),
          usage: {
            prompt_tokens: Number(json.usage?.prompt_tokens ?? 0),
            total_tokens: Number(json.usage?.total_tokens ?? 0),
          },
        };
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes('failed (4')) {
        throw error;
      }
    }
    if (attempt < config.max_provider_retries) {
      await delay(250 * 2 ** attempt);
    }
  }
  throw lastError || new Error('Embedding request failed');
}

export async function embedInBatches(texts, config, apiKey, onProgress) {
  const vectors = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  for (let index = 0; index < texts.length; index += config.embedding_batch) {
    const batch = texts.slice(index, index + config.embedding_batch);
    const result = await embedTexts(batch, config, apiKey);
    vectors.push(...result.vectors);
    usage.prompt_tokens += result.usage.prompt_tokens;
    usage.total_tokens += result.usage.total_tokens;
    onProgress?.(Math.min(index + batch.length, texts.length), texts.length);
  }
  return { vectors, usage };
}

export function createMilvusClient(config) {
  const clientConfig = { address: config.milvus_address };
  if (process.env.MILVUS_USER) {
    clientConfig.username = process.env.MILVUS_USER;
    clientConfig.password = process.env.MILVUS_PASSWORD || '';
  }
  return new MilvusClient(clientConfig);
}

export function collectionExists(response) {
  return response?.value === true || response === true;
}

export function normalizeSearchRows(result) {
  if (!result || typeof result !== 'object') return [];
  const results = result.results;
  if (!Array.isArray(results)) return [];
  const rows =
    results.length && Array.isArray(results[0]) ? results[0] : results;
  return rows.filter((row) => row && typeof row === 'object');
}

export function collectionRowCount(response) {
  const pairs = Array.isArray(response?.stats) ? response.stats : [];
  const rowCountPair = pairs.find((item) => item.key === 'row_count');
  const raw =
    rowCountPair?.value ??
    response?.data?.row_count ??
    response?.row_count ??
    null;
  const count = Number(raw);
  return Number.isFinite(count) ? count : null;
}

export function statePathFor(root, collection) {
  assertEvaluationCollection(collection);
  return path.join(root, 'evals/state', `${collection}.json`);
}

export function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filename);
}

export function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

export function validateIndexState(state, snapshot, config) {
  const mismatches = [];
  if (!state) return ['index state is missing'];
  const expected = {
    collection: config.collection,
    corpus_sha256: snapshot.corpus_sha256,
    chunks_sha256: snapshot.chunks_sha256,
    chunk_size: config.chunk_size,
    chunk_overlap: config.chunk_overlap,
    embedding_model: config.embedding_model,
    metric: config.metric,
    chunk_count: snapshot.chunks.length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value) {
      mismatches.push(`${key}: expected ${value}, found ${state[key]}`);
    }
  }
  return mismatches;
}
