/**
 * RAG ingest: chunk local markdown → OpenAI-compatible embeddings → Milvus.
 *
 * Usage:
 *   node scripts/rag-ingest.mjs
 *   node scripts/rag-ingest.mjs --recreate
 *   pnpm run rag:ingest
 *
 * Env (.env):
 *   OPENAI_API_KEY, OPENAI_BASE_URL
 *   EMBEDDING_MODEL (OpenAI: text-embedding-3-small; DashScope: text-embedding-v3)
 *   EMBEDDING_DIMENSIONS (optional; auto-detected from first vector if unset)
 *   MILVUS_ADDRESS (default localhost:19530)
 *   MILVUS_COLLECTION (default rag_docs)
 *   MILVUS_USER / MILVUS_PASSWORD (optional)
 *   RAG_DOCS_PATH (default docs/rag-sample)
 *   RAG_CHUNK_SIZE (default 800)
 *   RAG_CHUNK_OVERLAP (default 120)
 *   RAG_EMBED_BATCH (default 16)
*/
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const recreate = process.argv.includes('--recreate');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const baseURL = (
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
).replace(/\/$/, '');
const embeddingModel =
  process.env.EMBEDDING_MODEL ||
  (baseURL.includes('dashscope') || baseURL.includes('aliyuncs.com')
    ? 'text-embedding-v3'
    : 'text-embedding-3-small');
const milvusAddress = process.env.MILVUS_ADDRESS || 'localhost:19530';
const collectionName = process.env.MILVUS_COLLECTION || 'rag_docs';
const docsPath = path.resolve(
  ROOT,
  process.env.RAG_DOCS_PATH || 'docs/rag-sample',
);
const chunkSize = Number(process.env.RAG_CHUNK_SIZE || 800);
const chunkOverlap = Number(process.env.RAG_CHUNK_OVERLAP || 120);
const embedBatch = Number(process.env.RAG_EMBED_BATCH || 16);

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Docs path not found: ${dir}`);
  }
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      out.push(...listMarkdownFiles(full));
      continue;
    }
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.toLowerCase() === 'readme.md') continue;
    out.push(full);
  }
  return out.sort();
}

/** Simple character-window chunker with overlap (good enough for MVP). */
function chunkText(text, size, overlap) {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= size) return [cleaned];

  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(start + size, cleaned.length);
    // Prefer breaking at a paragraph / newline near the window end
    if (end < cleaned.length) {
      const window = cleaned.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf(' '),
      );
      if (breakAt > size * 0.4) {
        end = start + breakAt;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= cleaned.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

async function embedTexts(texts) {
  const response = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding API failed (${response.status}): ${errText}`);
  }

  const json = await response.json();
  const data = Array.isArray(json.data) ? json.data : [];
  if (data.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: expected ${texts.length}, got ${data.length}`,
    );
  }
  // OpenAI returns items with index; sort to be safe
  return data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding);
}

async function embedInBatches(texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += embedBatch) {
    const batch = texts.slice(i, i + embedBatch);
    process.stdout.write(
      `  embedding ${Math.min(i + batch.length, texts.length)}/${texts.length}\r`,
    );
    const batchVectors = await embedTexts(batch);
    vectors.push(...batchVectors);
  }
  process.stdout.write('\n');
  return vectors;
}

function buildChunksFromFiles(files) {
  const chunks = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, 'utf8');
    const parts = chunkText(content, chunkSize, chunkOverlap);
    parts.forEach((text, chunkIndex) => {
      chunks.push({
        source: rel,
        chunkIndex,
        text,
      });
    });
    console.log(`  ${rel}: ${parts.length} chunk(s)`);
  }
  return chunks;
}

async function ensureCollection(client, dim) {
  const has = await client.hasCollection({ collection_name: collectionName });
  const exists = has?.value === true || has === true;

  if (exists && recreate) {
    console.log(`Dropping collection "${collectionName}"...`);
    await client.dropCollection({ collection_name: collectionName });
  } else if (exists && !recreate) {
    console.log(
      `Collection "${collectionName}" already exists. Use --recreate to rebuild.`,
    );
    return false;
  }

  console.log(`Creating collection "${collectionName}" (dim=${dim})...`);
  await client.createCollection({
    collection_name: collectionName,
    fields: [
      {
        name: 'id',
        data_type: DataType.Int64,
        is_primary_key: true,
        autoID: true,
      },
      {
        name: 'embedding',
        data_type: DataType.FloatVector,
        dim,
      },
      {
        name: 'text',
        data_type: DataType.VarChar,
        max_length: 8192,
      },
      {
        name: 'source',
        data_type: DataType.VarChar,
        max_length: 512,
      },
      {
        name: 'chunk_index',
        data_type: DataType.Int64,
      },
    ],
  });

  await client.createIndex({
    collection_name: collectionName,
    field_name: 'embedding',
    index_name: 'embedding_idx',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  });

  await client.loadCollection({ collection_name: collectionName });
  return true;
}

async function main() {
  console.log('RAG ingest');
  console.log(`  docs: ${docsPath}`);
  console.log(`  milvus: ${milvusAddress}`);
  console.log(`  collection: ${collectionName}`);
  console.log(`  embedding model: ${embeddingModel}`);
  console.log(`  chunk: size=${chunkSize}, overlap=${chunkOverlap}`);

  const files = listMarkdownFiles(docsPath);
  if (!files.length) {
    console.error('No .md files found (README.md is skipped).');
    process.exit(1);
  }
  console.log(`Found ${files.length} markdown file(s):`);

  const chunks = buildChunksFromFiles(files);
  if (!chunks.length) {
    console.error('No chunks produced.');
    process.exit(1);
  }
  console.log(`Total chunks: ${chunks.length}`);

  // Truncate text field to Milvus VarChar limit
  const MAX_TEXT = 8000;
  for (const c of chunks) {
    if (c.text.length > MAX_TEXT) {
      c.text = c.text.slice(0, MAX_TEXT);
    }
  }

  console.log('Creating embeddings...');
  const vectors = await embedInBatches(chunks.map((c) => c.text));
  const dim =
    Number(process.env.EMBEDDING_DIMENSIONS) || vectors[0]?.length || 0;
  if (!dim) {
    throw new Error('Could not determine embedding dimension');
  }
  console.log(`Embedding dimension: ${dim}`);

  const clientConfig = { address: milvusAddress };
  if (process.env.MILVUS_USER) {
    clientConfig.username = process.env.MILVUS_USER;
    clientConfig.password = process.env.MILVUS_PASSWORD || '';
  }
  const client = new MilvusClient(clientConfig);

  try {
    const created = await ensureCollection(client, dim);
    if (!created && !recreate) {
      // Collection exists: still insert (may duplicate). Prefer --recreate for clean state.
      console.log('Inserting into existing collection (may create duplicates)...');
      await client.loadCollection({ collection_name: collectionName });
    }

    console.log('Inserting into Milvus...');
    const insertResult = await client.insert({
      collection_name: collectionName,
      fields_data: chunks.map((c, i) => ({
        embedding: vectors[i],
        text: c.text,
        source: c.source,
        chunk_index: c.chunkIndex,
      })),
    });

    if (insertResult?.status?.error_code && insertResult.status.error_code !== 'Success') {
      throw new Error(
        `Milvus insert failed: ${JSON.stringify(insertResult.status)}`,
      );
    }

    await client.flushSync({ collection_names: [collectionName] });
    console.log(`Done. Inserted ${chunks.length} chunk(s) into "${collectionName}".`);
  } finally {
    await client.closeConnection();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
