/**
 * Quick RAG search smoke test against Milvus (no Nest bootstrap).
 *
 * Usage:
 *   node scripts/rag-search.mjs "What is RAG?"
 *   pnpm run rag:search -- "How do I use Milvus with LangChain?"
 */
import 'dotenv/config';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

const query = process.argv.slice(2).filter((a) => a !== '--').join(' ').trim();
if (!query) {
  console.error('Usage: node scripts/rag-search.mjs "<query>"');
  process.exit(1);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY');
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
const topK = Number(process.env.RAG_TOP_K || 4);

async function embed(text) {
  const response = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: embeddingModel, input: [text] }),
  });
  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json();
  return json.data[0].embedding;
}

function normalizeRows(result) {
  const results = result?.results;
  if (!Array.isArray(results)) return [];
  if (results.length && Array.isArray(results[0])) return results[0];
  return results;
}

async function main() {
  console.log(`Query: ${query}`);
  console.log(`Milvus: ${milvusAddress} / ${collectionName} topK=${topK}`);

  const vector = await embed(query);
  const client = new MilvusClient({ address: milvusAddress });
  try {
    await client.loadCollection({ collection_name: collectionName });
    const result = await client.search({
      collection_name: collectionName,
      data: [vector],
      limit: topK,
      output_fields: ['text', 'source', 'chunk_index'],
      metric_type: 'COSINE',
      params: { nprobe: 10 },
    });

    const rows = normalizeRows(result);
    if (!rows.length) {
      console.log('No hits.');
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const score = Number(row.score ?? row.distance ?? 0);
      console.log('\n---');
      console.log(
        `[${i + 1}] source=${row.source} chunk=${row.chunk_index} score=${score.toFixed(4)}`,
      );
      console.log(String(row.text ?? '').slice(0, 500));
    }
  } finally {
    await client.closeConnection();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
