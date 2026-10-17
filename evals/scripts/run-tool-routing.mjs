import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import 'dotenv/config';
import {
  captureRuntimeConfig,
  fileSha256,
  sanitizeEndpoint,
} from '../lib/runtime-config.mjs';
import { scoreToolCases } from '../lib/scoring.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DATASET_ROOT = path.join(ROOT, 'evals/datasets');
const RESULTS_ROOT = path.join(ROOT, 'evals/results');
const PROMPT_PATH = path.join(ROOT, 'evals/prompts/tool-routing-v1.txt');
const TOOL_CLASSES = [
  'knowledge_search',
  'web_search',
  'send_mail',
  'query_user',
  'db_users_crud',
  'cron_job',
  'no_tool',
];

function parseArgs(argv) {
  const args = {
    dataset: 'evals/datasets/tool_smoke_v1.jsonl',
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
      console.log(`Usage: pnpm eval:tool -- [options]

Options:
  --dataset <path>          JSONL dataset under evals/datasets
  --case-id <id>            Run one case; repeat to select multiple cases
  --output-dir <path>       Result directory under evals/results
  --timeout-seconds <n>     Per-case provider timeout (default: 120)
  --dry-run                 Validate configuration without calling the model
  --help                    Show this help`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
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

function normalizeUserId(userId) {
  const trimmed = String(userId).trim();
  return /^\d+$/.test(trimmed) && trimmed.length < 3
    ? trimmed.padStart(3, '0')
    : trimmed;
}

function createMockTools() {
  const mockResult = async () => 'Mock evaluation result; no side effect ran.';
  return [
    tool(mockResult, {
      name: 'knowledge_search',
      description:
        'Search the local Milvus knowledge base (ingested docs under docs/rag-sample). Use for questions about LangChain, RAG, embeddings, Milvus, or other indexed documentation. Prefer this over web_search when the answer should come from local docs.',
      schema: z.object({
        query: z.string().min(1),
        topK: z.number().int().min(1).max(20).optional(),
      }),
    }),
    tool(mockResult, {
      name: 'query_user',
      description:
        'Look up in-memory demo users by ID. Returns name, email, and role.',
      schema: z.object({
        userId: z.coerce.string().transform((id) => normalizeUserId(id)),
      }),
    }),
    tool(mockResult, {
      name: 'send_mail',
      description:
        'Send email. Requires to, subject; optional text and html body.',
      schema: z.object({
        to: z.email(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
      }),
    }),
    tool(mockResult, {
      name: 'web_search',
      description:
        'Search the web via Bocha API. Input query and optional count.',
      schema: z.object({
        query: z.string().min(1),
        count: z.number().int().min(1).max(20).optional(),
      }),
    }),
    tool(mockResult, {
      name: 'db_users_crud',
      description:
        'CRUD on MySQL users table via action: create/list/get/update/delete.',
      schema: z.object({
        action: z.enum(['create', 'list', 'get', 'update', 'delete']),
        id: z.number().int().positive().optional(),
        name: z.string().min(1).max(50).optional(),
        email: z.email().max(50).optional(),
      }),
    }),
    tool(mockResult, {
      name: 'cron_job',
      description: 'Manage server-side scheduled jobs (list/add/toggle).',
      schema: z.object({
        action: z.enum(['list', 'add', 'toggle']),
        id: z.string().optional(),
        enabled: z.boolean().optional(),
        type: z.enum(['cron', 'every', 'at']).optional(),
        instruction: z.string().optional(),
        cron: z.string().optional(),
        everyMs: z.number().int().positive().optional(),
        at: z.string().optional(),
      }),
    }),
  ];
}

function usageFromMessage(message) {
  const usage = message.usage_metadata || {};
  const tokenUsage = message.response_metadata?.tokenUsage || {};
  const inputTokens = Number(
    usage.input_tokens ?? tokenUsage.promptTokens ?? 0,
  );
  const outputTokens = Number(
    usage.output_tokens ?? tokenUsage.completionTokens ?? 0,
  );
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number(
      usage.total_tokens ??
        tokenUsage.totalTokens ??
        inputTokens + outputTokens,
    ),
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

function normalizeToolCalls(message) {
  return (message.tool_calls || []).map((call) => ({
    id: call.id || null,
    name: call.name,
    arguments: call.args || {},
  }));
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

function addUsage(total, usage) {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.total_tokens += usage.total_tokens;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1];
}

function renderReport(summary, config) {
  const score = summary.score;
  const rows = TOOL_CLASSES.map((name) => {
    const metrics = score.per_class[name];
    return `| ${name} | ${(metrics.precision * 100).toFixed(1)}% | ${(metrics.recall * 100).toFixed(1)}% | ${(metrics.f1 * 100).toFixed(1)}% |`;
  }).join('\n');
  return `# Tool-Routing Evaluation Report

- Dataset: \`${config.dataset.path}\`
- Dataset SHA-256: \`${config.dataset.sha256}\`
- Model: \`${config.model_name}\`
- Protocol: \`${config.protocol_version}\`
- Side effects executed: **No**

## Summary

- Runs: ${summary.run_count}
- Evaluated cases: ${summary.evaluated_count}
- Infrastructure failures: ${summary.infrastructure_failure_count}
- Selection accuracy: ${(score.selection_accuracy * 100).toFixed(1)}%
- Macro F1: ${(score.macro_f1 * 100).toFixed(1)}%
- Routing task success: ${(score.routing_task_success * 100).toFixed(1)}%
- Schema validity: ${(score.schema_validity * 100).toFixed(1)}%
- Exact argument match: ${(score.exact_argument_match * 100).toFixed(1)}% (${score.exact_argument_labeled_cases} labeled cases)
- Multiple-tool-call cases: ${score.multiple_tool_call_count}
- Forbidden-tool violations: ${score.forbidden_tool_violation_count}
- P50 latency: ${summary.latency_ms.p50 ?? 'n/a'} ms
- P95 latency: ${summary.latency_ms.p95_nearest_rank ?? 'n/a'} ms
- Total tokens: ${summary.usage.total_tokens}

## Per-Class Metrics

| Class | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
${rows}
`;
}

async function runCase(modelWithTools, systemPrompt, testCase, timeoutSeconds) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const message = await modelWithTools.invoke(
      [new SystemMessage(systemPrompt), new HumanMessage(testCase.query)],
      { signal: AbortSignal.timeout(timeoutSeconds * 1000) },
    );
    return {
      id: testCase.id,
      status: 'completed',
      error: null,
      started_at: startedAt,
      latency_ms: Math.round(performance.now() - started),
      prediction: {
        id: testCase.id,
        tool_calls: normalizeToolCalls(message),
      },
      assistant_text: contentToText(message.content),
      usage: usageFromMessage(message),
    };
  } catch (error) {
    return {
      id: testCase.id,
      status: 'infrastructure_failure',
      error: error instanceof Error ? error.message : String(error),
      started_at: startedAt,
      latency_ms: Math.round(performance.now() - started),
      prediction: null,
      assistant_text: '',
      usage: null,
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

  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  const runtimeConfig = captureRuntimeConfig(ROOT, [datasetPath]);
  const config = {
    ...runtimeConfig,
    run_started_at: new Date().toISOString(),
    timeout_seconds: args.timeoutSeconds,
    dataset: {
      path: path.relative(ROOT, datasetPath),
      sha256: fileSha256(datasetPath),
      selected_case_count: cases.length,
      selected_case_ids: cases.map((testCase) => testCase.id),
    },
    prompt: {
      path: path.relative(ROOT, PROMPT_PATH),
      sha256: fileSha256(PROMPT_PATH),
    },
    evaluation_mode: 'first_turn_tool_routing',
    side_effects_executed: false,
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ valid: true, config }, null, 2));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  const rawBaseUrl = (
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).trim();
  sanitizeEndpoint(rawBaseUrl, 'https://api.openai.com/v1');
  const reasoningEffort = config.reasoning_effort || undefined;
  const model = new ChatOpenAI({
    modelName: config.model_name,
    apiKey,
    temperature: 0,
    maxRetries: config.max_provider_retries,
    configuration: { baseURL: rawBaseUrl },
    modelKwargs: reasoningEffort
      ? { reasoning_effort: reasoningEffort }
      : undefined,
  });
  const modelWithTools = model.bindTools(createMockTools());

  const requestedOutputDir =
    args.outputDir ||
    path.relative(ROOT, defaultOutputDir(config.model_name, datasetPath));
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

  const rawRuns = [];
  for (const [index, testCase] of cases.entries()) {
    process.stdout.write(`[${index + 1}/${cases.length}] ${testCase.id} ... `);
    const result = await runCase(
      modelWithTools,
      systemPrompt,
      testCase,
      args.timeoutSeconds,
    );
    rawRuns.push(result);
    console.log(result.status);
  }

  const completed = rawRuns.filter((run) => run.status === 'completed');
  const completedIds = new Set(completed.map((run) => run.id));
  const scoredCases = cases.filter((testCase) => completedIds.has(testCase.id));
  const predictions = completed.map((run) => run.prediction);
  const score = scoreToolCases(scoredCases, predictions, TOOL_CLASSES);
  const scoreById = new Map(score.case_results.map((item) => [item.id, item]));
  const outputRuns = rawRuns.map((run) => ({
    ...run,
    score: scoreById.get(run.id) || null,
  }));
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  for (const run of completed) addUsage(usage, run.usage);
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
    `${outputRuns.map((run) => JSON.stringify(run)).join('\n')}\n`,
  );
  fs.writeFileSync(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(outputDir, 'confusion_matrix.json'),
    `${JSON.stringify(score.confusion_matrix, null, 2)}\n`,
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
        selection_accuracy: score.selection_accuracy,
        macro_f1: score.macro_f1,
        routing_task_success: score.routing_task_success,
        schema_validity: score.schema_validity,
        exact_argument_match: score.exact_argument_match,
        total_tokens: usage.total_tokens,
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
