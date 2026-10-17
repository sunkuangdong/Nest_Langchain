import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { captureRuntimeConfig, fileSha256 } from '../lib/runtime-config.mjs';
import {
  buildCorpusSnapshot,
  collectionExists,
  collectionRowCount,
  createMilvusClient,
  embedTexts,
  getRagEvaluationConfig,
  normalizeSearchRows,
  readJson,
  statePathFor,
  validateIndexState,
} from '../lib/rag-runtime.mjs';
import { scoreRagCase } from '../lib/scoring.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DATASET_ROOT = path.join(ROOT, 'evals/datasets');
const RESULTS_ROOT = path.join(ROOT, 'evals/results');

function parseArgs(argv) {
  const args = {
    dataset: 'evals/datasets/rag_smoke_v1.jsonl',
    caseIds: [],
    outputDir: undefined,
    timeoutSeconds: Number(process.env.EVAL_TIMEOUT_SECONDS || 120),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') continue;
    if (value === '--dataset') args.dataset = argv[++index];
    else if (value === '--case-id') args.caseIds.push(argv[++index]);
    else if (value === '--output-dir') args.outputDir = argv[++index];
    else if (value === '--timeout-seconds') {
      args.timeoutSeconds = Number(argv[++index]);
    } else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--help' || value === '-h') {
      console.log(`Usage: pnpm eval:rag -- [options]

Options:
  --dataset <path>          JSONL dataset under evals/datasets
  --case-id <id>            Run one case; repeat to select multiple cases
  --output-dir <path>       Result directory under evals/results
  --timeout-seconds <n>     Per-request embedding timeout (default: 120)
  --dry-run                 Validate configuration without network calls
  --help                    Show this help`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be a positive number');
  }
  return args;
}

function resolveWithin(parent, requested, label) {
  const resolved = path.resolve(ROOT, requested);
  const relative = path.relative(parent, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${path.relative(ROOT, parent)}`);
  }
  return resolved;
}

function loadJsonl(filename) {
  return fs
    .readFileSync(filename, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `${path.relative(ROOT, filename)}:${index + 1}: ${error.message}`,
        );
      }
    });
}

function safeSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function defaultOutputDir(modelName, datasetPath) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const datasetName = path.basename(datasetPath, '.jsonl');
  return path.join(
    RESULTS_ROOT,
    `${timestamp}_${safeSegment(modelName)}_${safeSegment(datasetName)}`,
  );
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1];
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function formatPercent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDecimal(value) {
  return value === null ? 'n/a' : value.toFixed(4);
}

function normalizeHit(row) {
  const entity =
    row.entity && typeof row.entity === 'object' ? row.entity : row;
  return {
    text: typeof entity.text === 'string' ? entity.text : '',
    source: typeof entity.source === 'string' ? entity.source : '',
    chunk_index: Number(entity.chunk_index ?? 0),
    score: Number(row.score ?? row.distance ?? 0),
  };
}

function renderReport(summary, config) {
  const score = summary.score;
  return `# RAG Retrieval Evaluation Report

- Dataset: \`${config.dataset.path}\`
- Dataset SHA-256: \`${config.dataset.sha256}\`
- Corpus SHA-256: \`${config.index_state.corpus_sha256}\`
- Collection: \`${config.retrieval.collection}\`
- Embedding model: \`${config.retrieval.embedding_model}\`
- Protocol: \`${config.protocol_version}\`

## Summary

- Runs: ${summary.run_count}
- Evaluated cases: ${summary.evaluated_count}
- Infrastructure failures: ${summary.infrastructure_failure_count}
- Recall@1: ${formatPercent(score.recall_at_1)}
- Recall@3: ${formatPercent(score.recall_at_3)}
- Recall@5: ${formatPercent(score.recall_at_5)}
- MRR: ${formatDecimal(score.mrr)}
- Mean evidence coverage: ${formatPercent(score.mean_evidence_coverage)}
- Full evidence coverage: ${formatPercent(score.full_evidence_coverage_rate)}
- P50 latency: ${summary.latency_ms.p50 ?? 'n/a'} ms
- P95 latency: ${summary.latency_ms.p95_nearest_rank ?? 'n/a'} ms
- Query embedding tokens: ${summary.usage.total_tokens}

Latency is measured from the start of each query embedding request through
normalized Milvus Top-${config.retrieval.top_k} results. Infrastructure failures
are counted but excluded from retrieval-quality aggregates.
`;
}

async function runCase(client, config, apiKey, testCase) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const embedding = await embedTexts([testCase.query], config, apiKey);
    const result = await client.search({
      collection_name: config.collection,
      data: [embedding.vectors[0]],
      limit: config.top_k,
      output_fields: ['text', 'source', 'chunk_index'],
      metric_type: config.metric,
      params: { nprobe: 10 },
    });
    const hits = normalizeSearchRows(result).map(normalizeHit);
    return {
      id: testCase.id,
      status: 'completed',
      error: null,
      started_at: startedAt,
      latency_ms: Math.round(performance.now() - started),
      usage: embedding.usage,
      hits,
      score: scoreRagCase(testCase, hits),
    };
  } catch (error) {
    return {
      id: testCase.id,
      status: 'infrastructure_failure',
      error: error instanceof Error ? error.message : String(error),
      started_at: startedAt,
      latency_ms: Math.round(performance.now() - started),
      usage: null,
      hits: [],
      score: null,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = resolveWithin(DATASET_ROOT, args.dataset, 'dataset');
  const allCases = loadJsonl(datasetPath);
  const requestedIds = new Set(args.caseIds);
  const cases = requestedIds.size
    ? allCases.filter((testCase) => requestedIds.has(testCase.id))
    : allCases;
  const foundIds = new Set(cases.map((testCase) => testCase.id));
  const missingIds = [...requestedIds].filter((id) => !foundIds.has(id));
  if (missingIds.length) {
    throw new Error(`Case IDs not found: ${missingIds.join(', ')}`);
  }
  if (!cases.length) throw new Error('No evaluation cases selected');

  const ragConfig = getRagEvaluationConfig(ROOT);
  if (ragConfig.top_k < 5) {
    throw new Error('EVAL_RAG_TOP_K must be at least 5 to compute Recall@5');
  }
  ragConfig.timeout_seconds = args.timeoutSeconds;
  const snapshot = buildCorpusSnapshot(ROOT, ragConfig);
  const statePath = statePathFor(ROOT, ragConfig.collection);
  const stateExists = fs.existsSync(statePath);
  const state = stateExists ? readJson(statePath) : null;
  const stateMismatches = validateIndexState(state, snapshot, ragConfig);
  const runtimeConfig = captureRuntimeConfig(ROOT, [datasetPath]);
  const config = {
    ...runtimeConfig,
    run_started_at: new Date().toISOString(),
    timeout_seconds: args.timeoutSeconds,
    retrieval: {
      ...runtimeConfig.retrieval,
      collection: ragConfig.collection,
      chunk_size: ragConfig.chunk_size,
      chunk_overlap: ragConfig.chunk_overlap,
      top_k: ragConfig.top_k,
      metric: ragConfig.metric,
      embedding_model: ragConfig.embedding_model,
      concurrency: 1,
    },
    dataset: {
      path: path.relative(ROOT, datasetPath),
      sha256: fileSha256(datasetPath),
      selected_case_count: cases.length,
      selected_case_ids: cases.map((testCase) => testCase.id),
    },
    index_state: {
      path: path.relative(ROOT, statePath),
      sha256: stateExists ? fileSha256(statePath) : null,
      corpus_sha256: snapshot.corpus_sha256,
      chunks_sha256: snapshot.chunks_sha256,
      chunk_count: snapshot.chunks.length,
      valid: stateMismatches.length === 0,
      mismatches: stateMismatches,
    },
    evaluation_mode: 'retrieval_only',
    generated_answer_evaluated: false,
  };

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          valid: true,
          ready_for_live_run: stateMismatches.length === 0,
          config,
          next_command: stateExists
            ? 'pnpm eval:rag:smoke'
            : 'pnpm eval:rag:ingest',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (stateMismatches.length) {
    throw new Error(
      `Evaluation index state does not match the fixed corpus/configuration:\n- ${stateMismatches.join('\n- ')}\nRebuild with: pnpm eval:rag:ingest -- --recreate`,
    );
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');

  const requestedOutputDir =
    args.outputDir ||
    path.relative(
      ROOT,
      defaultOutputDir(ragConfig.embedding_model, datasetPath),
    );
  const outputDir = resolveWithin(
    RESULTS_ROOT,
    requestedOutputDir,
    'output directory',
  );
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const client = createMilvusClient(ragConfig);
  const rawRuns = [];
  try {
    const has = await client.hasCollection({
      collection_name: ragConfig.collection,
    });
    if (!collectionExists(has)) {
      throw new Error(
        `Evaluation collection "${ragConfig.collection}" does not exist. Run: pnpm eval:rag:ingest`,
      );
    }
    const statistics = await client.getCollectionStatistics({
      collection_name: ragConfig.collection,
    });
    const entityCount = collectionRowCount(statistics);
    if (entityCount !== null && entityCount !== state.entity_count) {
      throw new Error(
        `Milvus row count changed after indexing: expected ${state.entity_count}, found ${entityCount}`,
      );
    }
    await client.loadCollection({ collection_name: ragConfig.collection });

    for (const [index, testCase] of cases.entries()) {
      process.stdout.write(
        `[${index + 1}/${cases.length}] ${testCase.id} ... `,
      );
      const run = await runCase(client, ragConfig, apiKey, testCase);
      rawRuns.push(run);
      console.log(run.status);
    }
  } finally {
    await client.closeConnection();
  }

  const completed = rawRuns.filter((run) => run.status === 'completed');
  const scores = completed.map((run) => run.score);
  const score = {
    recall_at_1: average(scores.map((item) => item.recall_at_1)),
    recall_at_3: average(scores.map((item) => item.recall_at_3)),
    recall_at_5: average(scores.map((item) => item.recall_at_5)),
    mrr: average(scores.map((item) => item.reciprocal_rank)),
    mean_evidence_coverage: average(
      scores.map((item) => item.evidence_coverage),
    ),
    full_evidence_coverage_rate: average(
      scores.map((item) => (item.evidence_coverage === 1 ? 1 : 0)),
    ),
  };
  const usage = completed.reduce(
    (total, run) => ({
      prompt_tokens: total.prompt_tokens + run.usage.prompt_tokens,
      total_tokens: total.total_tokens + run.usage.total_tokens,
    }),
    { prompt_tokens: 0, total_tokens: 0 },
  );
  const latencies = completed.map((run) => run.latency_ms);
  const summary = {
    finished_at: new Date().toISOString(),
    run_count: rawRuns.length,
    evaluated_count: completed.length,
    infrastructure_failure_count: rawRuns.length - completed.length,
    status_counts: {
      completed: completed.length,
      infrastructure_failure: rawRuns.length - completed.length,
    },
    score,
    latency_ms: {
      sample_count: latencies.length,
      p50: percentile(latencies, 0.5),
      p95_nearest_rank: percentile(latencies, 0.95),
    },
    usage,
  };

  fs.writeFileSync(
    path.join(outputDir, 'raw_cases.jsonl'),
    `${rawRuns.map((run) => JSON.stringify(run)).join('\n')}\n`,
  );
  fs.writeFileSync(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(outputDir, 'report.md'),
    renderReport(summary, config),
  );
  console.log(`Results: ${path.relative(ROOT, outputDir)}`);
  console.log(
    JSON.stringify(
      {
        run_count: summary.run_count,
        evaluated_count: summary.evaluated_count,
        infrastructure_failure_count: summary.infrastructure_failure_count,
        ...score,
        latency_ms: summary.latency_ms,
        usage,
      },
      null,
      2,
    ),
  );
  if (summary.infrastructure_failure_count) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
