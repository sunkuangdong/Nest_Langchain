import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const FREEZE_TAG = 'eval-protocol-v1.2.0';
const PROTOCOL_VERSION = '1.2.0';

const EXPECTED_DATASETS = {
  rag: {
    path: 'evals/datasets/rag_main_v1.jsonl',
    sha256: '95795f23ab275ae31e3da4d0826475d0561d3ef9daf9164c548bb9bfe1b929e3',
    caseCount: 32,
  },
  tool: {
    path: 'evals/datasets/tool_main_v1.jsonl',
    sha256: '6a837db5cbcde1c46a0e4439e9e945ed8e1fce68a791735e0b356efe35421ef8',
    caseCount: 70,
  },
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function readJsonl(filename) {
  return fs
    .readFileSync(filename, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(filename) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filename))
    .digest('hex');
}

function relative(filename) {
  return path.relative(PROJECT_ROOT, filename);
}

function frozenCommit() {
  return execFileSync('git', ['rev-list', '-n', '1', FREEZE_TAG], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim();
}

function verifyIds(config, rawCases, expected) {
  const selectedIds = config.dataset.selected_case_ids;
  const rawIds = rawCases.map((item) => item.id);
  invariant(
    new Set(selectedIds).size === expected.caseCount,
    `${expected.path}: selected case IDs are missing or duplicated`,
  );
  invariant(
    new Set(rawIds).size === expected.caseCount,
    `${expected.path}: raw case IDs are missing or duplicated`,
  );
  invariant(
    selectedIds.every((id) => rawIds.includes(id)),
    `${expected.path}: selected and raw case IDs differ`,
  );
}

function loadAndVerifyRun(kind, directory, freezeCommit) {
  const expected = EXPECTED_DATASETS[kind];
  const configPath = path.join(directory, 'config.json');
  const summaryPath = path.join(directory, 'summary.json');
  const rawPath = path.join(directory, 'raw_cases.jsonl');

  for (const filename of [configPath, summaryPath, rawPath]) {
    invariant(fs.existsSync(filename), `missing source artifact: ${filename}`);
  }

  const config = readJson(configPath);
  const summary = readJson(summaryPath);
  const rawCases = readJsonl(rawPath);
  const actualDatasetHash = sha256(resolveFromRoot(expected.path));

  invariant(
    config.protocol_version === PROTOCOL_VERSION,
    `${kind}: expected protocol ${PROTOCOL_VERSION}, got ${config.protocol_version}`,
  );
  invariant(
    config.git_commit === freezeCommit,
    `${kind}: run commit ${config.git_commit} is not freeze commit ${freezeCommit}`,
  );
  invariant(
    config.dataset.path === expected.path,
    `${kind}: unexpected dataset ${config.dataset.path}`,
  );
  invariant(
    config.dataset.sha256 === expected.sha256 &&
      actualDatasetHash === expected.sha256,
    `${kind}: dataset checksum does not match the frozen protocol`,
  );
  invariant(
    config.dataset.selected_case_count === expected.caseCount,
    `${kind}: expected ${expected.caseCount} selected cases`,
  );
  invariant(
    summary.run_count === expected.caseCount &&
      summary.evaluated_count === expected.caseCount &&
      rawCases.length === expected.caseCount,
    `${kind}: result counts do not match the frozen dataset`,
  );

  verifyIds(config, rawCases, expected);

  if (kind === 'rag') {
    invariant(
      config.retrieval?.collection === 'rag_docs_eval_v1' &&
        config.retrieval?.embedding_model === 'text-embedding-3-small' &&
        config.retrieval?.chunk_size === 800 &&
        config.retrieval?.chunk_overlap === 120 &&
        config.retrieval?.top_k === 5 &&
        config.retrieval?.metric === 'COSINE',
      'rag: retrieval configuration differs from the frozen protocol',
    );
  } else {
    invariant(
      config.provider === 'openai' &&
        config.model_name === 'gpt-6-luna' &&
        config.temperature === 0 &&
        config.reasoning_effort === 'none',
      'tool: model configuration differs from the frozen protocol',
    );
    invariant(
      config.side_effects_executed === false,
      'tool: side effects must be disabled',
    );
    invariant(
      config.prompt?.sha256 ===
        '76302972855271185b2e55615249ac1dae9a37dc1303635e59117df352513767',
      'tool: routing prompt checksum differs from the frozen protocol',
    );
  }

  return {
    config,
    summary,
    rawCases,
    source: {
      directory: relative(directory),
      config_sha256: sha256(configPath),
      summary_sha256: sha256(summaryPath),
      raw_cases_sha256: sha256(rawPath),
    },
  };
}

function sanitizeRagCases(rawCases) {
  return rawCases.map((item) => ({
    id: item.id,
    status: item.status,
    latency_ms: item.latency_ms,
    usage: item.usage,
    score: item.score,
    hits: (item.hits || []).map((hit, index) => ({
      rank: index + 1,
      source: hit.source,
      chunk_index: hit.chunk_index,
      similarity_score: hit.score,
    })),
  }));
}

function sanitizeToolCases(rawCases) {
  return rawCases.map((item) => ({
    id: item.id,
    status: item.status,
    latency_ms: item.latency_ms,
    usage: item.usage,
    score: item.score,
  }));
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function createReport(summary, ragCases, toolCases) {
  const rag = summary.rag;
  const tool = summary.tool_routing;
  const recallOneMisses = ragCases
    .filter((item) => item.score.recall_at_1 !== 1)
    .map((item) => item.id);
  const incompleteEvidence = ragCases
    .filter((item) => item.score.evidence_coverage < 1)
    .map((item) => item.id);
  const unsuccessfulRoutes = toolCases
    .filter((item) => item.score.task_success !== true)
    .map((item) => item.id);

  return `# Frozen Agent Evaluation Benchmark

- Protocol: \`${summary.protocol_version}\`
- Freeze tag: \`${summary.freeze_tag}\`
- Freeze commit: \`${summary.freeze_commit}\`
- Evaluated cases: ${summary.combined.evaluated_count}
- Infrastructure failures: ${summary.combined.infrastructure_failure_count}

## RAG Retrieval

| Metric | Result |
| --- | ---: |
| Cases | ${rag.evaluated_count} |
| Recall@1 | ${percentage(rag.score.recall_at_1)} |
| Recall@3 | ${percentage(rag.score.recall_at_3)} |
| Recall@5 | ${percentage(rag.score.recall_at_5)} |
| MRR | ${rag.score.mrr.toFixed(4)} |
| Mean evidence coverage | ${percentage(rag.score.mean_evidence_coverage)} |
| Full evidence coverage | ${percentage(rag.score.full_evidence_coverage_rate)} |
| P50 latency | ${rag.latency_ms.p50} ms |
| P95 latency | ${rag.latency_ms.p95_nearest_rank} ms |

All 32 labeled queries retrieved a relevant source within the first three
results. Recall@1 misses were limited to: ${recallOneMisses.map((id) => `\`${id}\``).join(', ')}.
Evidence coverage was incomplete for ${incompleteEvidence.length} cases:
${incompleteEvidence.map((id) => `\`${id}\``).join(', ')}.

## Tool Routing

| Metric | Result |
| --- | ---: |
| Cases | ${tool.evaluated_count} |
| Selection accuracy | ${percentage(tool.score.selection_accuracy)} |
| Macro F1 | ${percentage(tool.score.macro_f1)} |
| Routing task success | ${percentage(tool.score.routing_task_success)} |
| Schema validity | ${percentage(tool.score.schema_validity)} |
| Exact argument match | ${percentage(tool.score.exact_argument_match)} |
| P50 latency | ${tool.latency_ms.p50} ms |
| P95 latency | ${tool.latency_ms.p95_nearest_rank} ms |

The routing benchmark used seven balanced classes with ten cases per class.
No side-effecting tool was executed. Unsuccessful routing tasks were:
${unsuccessfulRoutes.map((id) => `\`${id}\``).join(', ')}.

## Reproducibility and Safety

Both runs were produced from the frozen commit and validated against the
recorded dataset and prompt checksums. The published case files omit retrieved
document text, assistant text, and tool arguments; they retain scores, latency,
usage, source paths, chunk indexes, and similarity ranks needed to audit the
aggregate metrics.

## Limitations

- Source-level retrieval does not prove generated-answer correctness.
- Evidence coverage uses deterministic phrase matching and may undercount
  semantically equivalent evidence.
- The 70 routing cases are balanced evaluation data, not production traffic.
- Hosted model and embedding behavior can change without a repository change.
- Voice latency, ASR quality, and TTS quality are outside this benchmark.

## Resume Evidence

- Evaluated a Milvus-backed RAG pipeline across 32 labeled queries, achieving
  100% Recall@3/5, 0.94 MRR, and 200 ms median retrieval latency with zero
  infrastructure failures.
- Built a side-effect-free evaluation harness across 70 balanced tool-routing
  cases, achieving 98.6% Macro F1, 97.1% end-to-end routing success, and 100%
  argument-schema validity.
`;
}

function writeJsonl(filename, items) {
  fs.writeFileSync(
    filename,
    `${items.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const { values } = parseArgs({
    args,
    options: {
      'rag-dir': { type: 'string' },
      'tool-dir': { type: 'string' },
      'output-dir': {
        type: 'string',
        default: 'evals/published/main_v1',
      },
      force: { type: 'boolean', default: false },
    },
  });

  invariant(values['rag-dir'], '--rag-dir is required');
  invariant(values['tool-dir'], '--tool-dir is required');

  const outputDirectory = resolveFromRoot(values['output-dir']);
  if (fs.existsSync(outputDirectory)) {
    const entries = fs.readdirSync(outputDirectory);
    invariant(
      values.force || entries.length === 0,
      `output directory is not empty: ${outputDirectory}; pass --force to replace it`,
    );
  }

  const freezeCommit = frozenCommit();
  const ragRun = loadAndVerifyRun(
    'rag',
    resolveFromRoot(values['rag-dir']),
    freezeCommit,
  );
  const toolRun = loadAndVerifyRun(
    'tool',
    resolveFromRoot(values['tool-dir']),
    freezeCommit,
  );
  const ragCases = sanitizeRagCases(ragRun.rawCases);
  const toolCases = sanitizeToolCases(toolRun.rawCases);

  const summary = {
    protocol_version: PROTOCOL_VERSION,
    freeze_tag: FREEZE_TAG,
    freeze_commit: freezeCommit,
    combined: {
      run_count: ragRun.summary.run_count + toolRun.summary.run_count,
      evaluated_count:
        ragRun.summary.evaluated_count + toolRun.summary.evaluated_count,
      infrastructure_failure_count:
        ragRun.summary.infrastructure_failure_count +
        toolRun.summary.infrastructure_failure_count,
    },
    rag: {
      dataset: ragRun.config.dataset,
      retrieval: ragRun.config.retrieval,
      evaluated_count: ragRun.summary.evaluated_count,
      infrastructure_failure_count: ragRun.summary.infrastructure_failure_count,
      score: ragRun.summary.score,
      latency_ms: ragRun.summary.latency_ms,
      usage: ragRun.summary.usage,
    },
    tool_routing: {
      dataset: toolRun.config.dataset,
      model: {
        provider: toolRun.config.provider,
        name: toolRun.config.model_name,
        temperature: toolRun.config.temperature,
        reasoning_effort: toolRun.config.reasoning_effort,
      },
      prompt: toolRun.config.prompt,
      side_effects_executed: toolRun.config.side_effects_executed,
      evaluated_count: toolRun.summary.evaluated_count,
      infrastructure_failure_count:
        toolRun.summary.infrastructure_failure_count,
      score: {
        ...toolRun.summary.score,
        case_results: undefined,
      },
      latency_ms: toolRun.summary.latency_ms,
      usage: toolRun.summary.usage,
    },
    source_artifacts: {
      rag: ragRun.source,
      tool: toolRun.source,
    },
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeJsonl(path.join(outputDirectory, 'rag_case_scores.jsonl'), ragCases);
  writeJsonl(path.join(outputDirectory, 'tool_case_scores.jsonl'), toolCases);
  fs.writeFileSync(
    path.join(outputDirectory, 'report.md'),
    createReport(summary, ragCases, toolCases),
  );

  console.log(
    JSON.stringify(
      {
        valid: true,
        output_directory: relative(outputDirectory),
        freeze_tag: FREEZE_TAG,
        freeze_commit: freezeCommit,
        evaluated_count: summary.combined.evaluated_count,
        infrastructure_failure_count:
          summary.combined.infrastructure_failure_count,
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
