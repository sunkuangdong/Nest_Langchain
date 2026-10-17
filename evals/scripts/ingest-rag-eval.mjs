import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataType } from '@zilliz/milvus2-sdk-node';
import 'dotenv/config';
import { captureRuntimeConfig } from '../lib/runtime-config.mjs';
import {
  buildCorpusSnapshot,
  collectionExists,
  collectionRowCount,
  createMilvusClient,
  embedInBatches,
  getRagEvaluationConfig,
  statePathFor,
  writeJsonAtomic,
} from '../lib/rag-runtime.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function parseArgs(argv) {
  const args = { recreate: false, dryRun: false };
  for (const value of argv) {
    if (value === '--') continue;
    if (value === '--recreate') args.recreate = true;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--help' || value === '-h') {
      console.log(`Usage: pnpm eval:rag:ingest -- [options]

Options:
  --recreate   Drop and rebuild the exact evaluation collection
  --dry-run    Validate corpus and configuration without network calls
  --help       Show this help`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function safeConfig(config) {
  return {
    model_base_url: config.model_base_url,
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    embedding_batch: config.embedding_batch,
    timeout_seconds: config.timeout_seconds,
    max_provider_retries: config.max_provider_retries,
    milvus_address: config.milvus_address,
    collection: config.collection,
    docs_path: config.docs_path_relative,
    chunk_size: config.chunk_size,
    chunk_overlap: config.chunk_overlap,
    metric: config.metric,
  };
}

async function createCollection(client, config, dimensions) {
  await client.createCollection({
    collection_name: config.collection,
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
        dim: dimensions,
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
    collection_name: config.collection,
    field_name: 'embedding',
    index_name: 'embedding_idx',
    index_type: 'AUTOINDEX',
    metric_type: config.metric,
  });
}

function assertInsertSucceeded(result) {
  const errorCode = result?.status?.error_code;
  if (errorCode && errorCode !== 'Success') {
    throw new Error(`Milvus insert failed: ${JSON.stringify(result.status)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getRagEvaluationConfig(ROOT);
  const snapshot = buildCorpusSnapshot(ROOT, config);
  const runtimeConfig = captureRuntimeConfig(ROOT, []);
  const statePath = statePathFor(ROOT, config.collection);
  const plan = {
    valid: true,
    dry_run: args.dryRun,
    recreate: args.recreate,
    config: safeConfig(config),
    corpus: {
      file_count: snapshot.manifest.length,
      chunk_count: snapshot.chunks.length,
      corpus_sha256: snapshot.corpus_sha256,
      chunks_sha256: snapshot.chunks_sha256,
      files: snapshot.manifest,
    },
    state_path: path.relative(ROOT, statePath),
  };
  if (args.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  const client = createMilvusClient(config);
  try {
    const has = await client.hasCollection({
      collection_name: config.collection,
    });
    const exists = collectionExists(has);
    if (exists && !args.recreate) {
      throw new Error(
        `Evaluation collection "${config.collection}" already exists. Refusing to append duplicate vectors. Reuse it for evaluation, or run with --recreate to rebuild it.`,
      );
    }

    console.log(
      `Embedding ${snapshot.chunks.length} fixed-corpus chunks with ${config.embedding_model}...`,
    );
    const embeddingResult = await embedInBatches(
      snapshot.chunks.map((chunk) => chunk.text),
      config,
      apiKey,
      (completed, total) => console.log(`  embedded ${completed}/${total}`),
    );
    const dimensions =
      config.embedding_dimensions || embeddingResult.vectors[0]?.length || 0;
    if (!dimensions) {
      throw new Error('Could not determine embedding dimensions');
    }
    if (
      embeddingResult.vectors.some((vector) => vector.length !== dimensions)
    ) {
      throw new Error('Embedding dimensions are inconsistent');
    }

    if (exists) {
      console.log(`Dropping evaluation collection "${config.collection}"...`);
      await client.dropCollection({ collection_name: config.collection });
    }

    console.log(
      `Creating evaluation collection "${config.collection}" (dim=${dimensions})...`,
    );
    await createCollection(client, config, dimensions);
    const insertResult = await client.insert({
      collection_name: config.collection,
      fields_data: snapshot.chunks.map((chunk, index) => ({
        embedding: embeddingResult.vectors[index],
        text: chunk.text,
        source: chunk.source,
        chunk_index: chunk.chunk_index,
      })),
    });
    assertInsertSucceeded(insertResult);
    await client.flushSync({ collection_names: [config.collection] });
    await client.loadCollection({ collection_name: config.collection });

    const statistics = await client.getCollectionStatistics({
      collection_name: config.collection,
    });
    const entityCount = collectionRowCount(statistics);
    if (entityCount !== null && entityCount !== snapshot.chunks.length) {
      throw new Error(
        `Milvus row-count mismatch: expected ${snapshot.chunks.length}, found ${entityCount}`,
      );
    }
    let milvusVersion = 'unknown';
    try {
      const version = await client.getVersion();
      milvusVersion = version?.version || 'unknown';
    } catch {
      // Version metadata is useful but not required to validate the index.
    }

    const state = {
      state_version: 1,
      created_at: new Date().toISOString(),
      protocol_version: runtimeConfig.protocol_version,
      git_commit: runtimeConfig.git_commit,
      collection: config.collection,
      corpus_sha256: snapshot.corpus_sha256,
      chunks_sha256: snapshot.chunks_sha256,
      corpus_manifest: snapshot.manifest,
      chunk_size: config.chunk_size,
      chunk_overlap: config.chunk_overlap,
      chunk_count: snapshot.chunks.length,
      embedding_model: config.embedding_model,
      embedding_dimensions: dimensions,
      metric: config.metric,
      index_type: 'AUTOINDEX',
      milvus_address: config.milvus_address,
      milvus_version: milvusVersion,
      entity_count: entityCount ?? snapshot.chunks.length,
      embedding_usage: embeddingResult.usage,
    };
    writeJsonAtomic(statePath, state);
    console.log(
      JSON.stringify(
        {
          status: 'completed',
          collection: config.collection,
          chunk_count: snapshot.chunks.length,
          entity_count: state.entity_count,
          embedding_dimensions: dimensions,
          corpus_sha256: snapshot.corpus_sha256,
          state_path: path.relative(ROOT, statePath),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.closeConnection();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
