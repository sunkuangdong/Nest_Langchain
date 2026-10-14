import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DATASET_DIR = path.join(ROOT, 'evals/datasets');
const TOOL_CLASSES = [
  'knowledge_search',
  'web_search',
  'send_mail',
  'query_user',
  'db_users_crud',
  'cron_job',
  'no_tool',
];
const TOOL_ARGUMENTS = {
  knowledge_search: new Set(['query', 'topK']),
  web_search: new Set(['query', 'count']),
  send_mail: new Set(['to', 'subject', 'text', 'html']),
  query_user: new Set(['userId']),
  db_users_crud: new Set(['action', 'id', 'name', 'email']),
  cron_job: new Set([
    'action',
    'id',
    'enabled',
    'type',
    'instruction',
    'cron',
    'everyMs',
    'at',
  ]),
  no_tool: new Set(),
};

function loadJsonl(filename) {
  const fullPath = path.join(DATASET_DIR, filename);
  const rows = fs
    .readFileSync(fullPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filename}:${index + 1}: ${error.message}`);
      }
    });
  return { filename, fullPath, rows };
}

function sha256(fullPath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(fullPath))
    .digest('hex');
}

function sameKeys(row, expected) {
  return (
    JSON.stringify(Object.keys(row).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function validateRag(dataset, expectedSize) {
  const errors = [];
  const expectedFields = [
    'id',
    'query',
    'relevant_sources',
    'expected_evidence',
  ];
  if (dataset.rows.length !== expectedSize) {
    errors.push(
      `${dataset.filename}: expected ${expectedSize}, found ${dataset.rows.length}`,
    );
  }
  const ids = new Set();
  for (const [index, row] of dataset.rows.entries()) {
    const at = `${dataset.filename}:${index + 1}`;
    if (!sameKeys(row, expectedFields)) errors.push(`${at}: unexpected schema`);
    if (!row.id || ids.has(row.id))
      errors.push(`${at}: missing or duplicate id`);
    ids.add(row.id);
    if (typeof row.query !== 'string' || !row.query.trim())
      errors.push(`${at}: invalid query`);
    if (!Array.isArray(row.relevant_sources) || !row.relevant_sources.length) {
      errors.push(`${at}: relevant_sources must be non-empty`);
      continue;
    }
    if (
      !Array.isArray(row.expected_evidence) ||
      !row.expected_evidence.length
    ) {
      errors.push(`${at}: expected_evidence must be non-empty`);
      continue;
    }
    const sourceTexts = [];
    for (const source of row.relevant_sources) {
      const normalized = path.normalize(source);
      if (!normalized.startsWith(path.normalize('docs/rag-sample/'))) {
        errors.push(`${at}: source outside fixed corpus: ${source}`);
        continue;
      }
      const sourcePath = path.join(ROOT, normalized);
      if (!fs.existsSync(sourcePath)) {
        errors.push(`${at}: source does not exist: ${source}`);
        continue;
      }
      sourceTexts.push(fs.readFileSync(sourcePath, 'utf8').toLowerCase());
    }
    const corpusText = sourceTexts.join('\n');
    for (const evidence of row.expected_evidence) {
      if (
        typeof evidence !== 'string' ||
        !corpusText.includes(evidence.toLowerCase())
      ) {
        errors.push(
          `${at}: evidence not found in relevant sources: ${evidence}`,
        );
      }
    }
  }
  return errors;
}

function validateTools(dataset, expectedPerClass) {
  const errors = [];
  const expectedFields = [
    'id',
    'query',
    'expected_tool',
    'required_arguments',
    'forbidden_tools',
    'side_effect',
  ];
  const counts = Object.fromEntries(TOOL_CLASSES.map((name) => [name, 0]));
  const ids = new Set();
  for (const [index, row] of dataset.rows.entries()) {
    const at = `${dataset.filename}:${index + 1}`;
    if (!sameKeys(row, expectedFields)) errors.push(`${at}: unexpected schema`);
    if (!row.id || ids.has(row.id))
      errors.push(`${at}: missing or duplicate id`);
    ids.add(row.id);
    if (!TOOL_CLASSES.includes(row.expected_tool)) {
      errors.push(`${at}: unsupported expected_tool ${row.expected_tool}`);
      continue;
    }
    counts[row.expected_tool] += 1;
    if (typeof row.query !== 'string' || !row.query.trim())
      errors.push(`${at}: invalid query`);
    if (!Array.isArray(row.required_arguments))
      errors.push(`${at}: required_arguments must be an array`);
    for (const argument of row.required_arguments || []) {
      if (!TOOL_ARGUMENTS[row.expected_tool].has(argument)) {
        errors.push(
          `${at}: invalid required argument ${argument} for ${row.expected_tool}`,
        );
      }
    }
    if (!Array.isArray(row.forbidden_tools))
      errors.push(`${at}: forbidden_tools must be an array`);
    for (const forbidden of row.forbidden_tools || []) {
      if (
        !TOOL_CLASSES.includes(forbidden) ||
        forbidden === row.expected_tool
      ) {
        errors.push(`${at}: invalid forbidden tool ${forbidden}`);
      }
    }
    if (typeof row.side_effect !== 'boolean')
      errors.push(`${at}: side_effect must be boolean`);
    if (row.expected_tool === 'no_tool' && row.required_arguments.length) {
      errors.push(`${at}: no_tool cannot require arguments`);
    }
  }
  for (const name of TOOL_CLASSES) {
    if (counts[name] !== expectedPerClass) {
      errors.push(
        `${dataset.filename}: ${name} expected ${expectedPerClass}, found ${counts[name]}`,
      );
    }
  }
  return { errors, counts };
}

function assertDisjoint(left, right, label) {
  const leftQueries = new Set(
    left.rows.map((row) => row.query.trim().toLowerCase()),
  );
  const overlap = right.rows
    .map((row) => row.query.trim().toLowerCase())
    .filter((query) => leftQueries.has(query));
  return overlap.length
    ? [`${label} smoke/main query overlap: ${overlap.join(', ')}`]
    : [];
}

const ragSmoke = loadJsonl('rag_smoke_v1.jsonl');
const ragMain = loadJsonl('rag_main_v1.jsonl');
const toolSmoke = loadJsonl('tool_smoke_v1.jsonl');
const toolMain = loadJsonl('tool_main_v1.jsonl');
const smokeTools = validateTools(toolSmoke, 2);
const mainTools = validateTools(toolMain, 10);
const errors = [
  ...validateRag(ragSmoke, 8),
  ...validateRag(ragMain, 32),
  ...smokeTools.errors,
  ...mainTools.errors,
  ...assertDisjoint(ragSmoke, ragMain, 'RAG'),
  ...assertDisjoint(toolSmoke, toolMain, 'tool'),
];
const report = {
  valid: errors.length === 0,
  datasets: [ragSmoke, ragMain, toolSmoke, toolMain].map((dataset) => ({
    path: path.relative(ROOT, dataset.fullPath),
    case_count: dataset.rows.length,
    sha256: sha256(dataset.fullPath),
  })),
  class_counts: {
    tool_smoke: smokeTools.counts,
    tool_main: mainTools.counts,
  },
  errors,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.valid ? 0 : 1;
