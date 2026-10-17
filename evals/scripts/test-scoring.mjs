import assert from 'node:assert/strict';
import { sanitizeEndpoint } from '../lib/runtime-config.mjs';
import {
  assertEvaluationCollection,
  buildCorpusSnapshot,
  chunkText,
  getRagEvaluationConfig,
  validateIndexState,
} from '../lib/rag-runtime.mjs';
import {
  scoreRagCase,
  scoreToolCases,
  validateToolArguments,
} from '../lib/scoring.mjs';

const rag = scoreRagCase(
  {
    relevant_sources: ['docs/b.md'],
    expected_evidence: ['dense + sparse', 'reranked'],
  },
  [
    { source: 'docs/a.md', text: 'unrelated' },
    { source: 'docs/b.md', text: 'Dense + sparse candidates are reranked.' },
  ],
);
assert.equal(rag.recall_at_1, 0);
assert.equal(rag.recall_at_3, 1);
assert.equal(rag.reciprocal_rank, 0.5);
assert.equal(rag.evidence_coverage, 1);

const classes = ['knowledge_search', 'no_tool'];
const tools = scoreToolCases(
  [
    {
      id: 'one',
      expected_tool: 'knowledge_search',
      required_arguments: ['query'],
      forbidden_tools: ['web_search'],
    },
    {
      id: 'two',
      expected_tool: 'no_tool',
      required_arguments: [],
      forbidden_tools: ['knowledge_search'],
    },
  ],
  [
    {
      id: 'one',
      selected_tool: 'knowledge_search',
      arguments: { query: 'RAG' },
    },
    { id: 'two', selected_tool: 'no_tool', arguments: {} },
  ],
  classes,
);
assert.equal(tools.selection_accuracy, 1);
assert.equal(tools.macro_f1, 1);
assert.equal(tools.schema_validity, 1);
assert.equal(tools.routing_task_success, 1);

assert.equal(
  validateToolArguments('knowledge_search', { query: 'RAG', topK: 5 }).valid,
  true,
);
assert.equal(
  validateToolArguments('knowledge_search', { query: 'RAG', topK: 0 }).valid,
  false,
);
assert.equal(
  validateToolArguments('db_users_crud', {
    action: 'create',
    name: 'Mia',
  }).valid,
  false,
);
assert.equal(
  validateToolArguments('cron_job', {
    action: 'add',
    type: 'at',
    instruction: 'publish report',
    at: 'not-a-date',
  }).valid,
  false,
);

const guarded = scoreToolCases(
  [
    {
      id: 'exact',
      expected_tool: 'knowledge_search',
      required_arguments: ['query', 'topK'],
      expected_arguments: { topK: 5 },
      forbidden_tools: ['web_search'],
    },
    {
      id: 'multiple',
      expected_tool: 'knowledge_search',
      required_arguments: ['query'],
      forbidden_tools: ['web_search'],
    },
    {
      id: 'no-tool',
      expected_tool: 'no_tool',
      required_arguments: [],
      forbidden_tools: ['knowledge_search', 'web_search'],
    },
  ],
  [
    {
      id: 'exact',
      tool_calls: [
        { name: 'knowledge_search', args: { query: 'RAG', topK: 5 } },
      ],
    },
    {
      id: 'multiple',
      tool_calls: [
        { name: 'knowledge_search', args: { query: 'RAG' } },
        { name: 'web_search', args: { query: 'RAG' } },
      ],
    },
    {
      id: 'no-tool',
      tool_calls: [{ name: 'knowledge_search', args: { query: 'RAG' } }],
    },
  ],
  ['knowledge_search', 'web_search', 'no_tool'],
);
assert.equal(guarded.selection_accuracy, 1 / 3);
assert.equal(guarded.routing_task_success, 1 / 3);
assert.equal(guarded.multiple_tool_call_count, 1);
assert.equal(guarded.forbidden_tool_violation_count, 2);
assert.equal(guarded.exact_argument_match, 1);

const missingTaskArgument = scoreToolCases(
  [
    {
      id: 'email',
      expected_tool: 'send_mail',
      required_arguments: ['to', 'subject', 'text'],
      expected_arguments: {
        to: 'qa@example.com',
        subject: 'Result',
      },
      forbidden_tools: [],
    },
  ],
  [
    {
      id: 'email',
      selected_tool: 'send_mail',
      arguments: { to: 'qa@example.com', subject: 'Result' },
    },
  ],
  ['send_mail', 'no_tool'],
);
assert.equal(missingTaskArgument.selection_accuracy, 1);
assert.equal(missingTaskArgument.schema_validity, 1);
assert.equal(missingTaskArgument.routing_task_success, 0);

const endpoint = sanitizeEndpoint(
  'https://user:secret@example.com:8443/v1?api_key=secret#fragment',
  'https://api.openai.com/v1',
);
assert.equal(endpoint, 'https://example.com:8443/v1');
assert.equal(endpoint.includes('secret'), false);

assert.deepEqual(chunkText('abcdefghij', 6, 2), ['abcdef', 'efghij']);
assert.doesNotThrow(() => assertEvaluationCollection('rag_docs_eval_v1'));
assert.throws(
  () => assertEvaluationCollection('rag_docs'),
  /non-evaluation collection/,
);

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ragConfig = getRagEvaluationConfig(root);
const snapshot = buildCorpusSnapshot(root, ragConfig);
assert.equal(snapshot.manifest.length, 4);
assert.equal(snapshot.chunks.length > 0, true);
assert.deepEqual(
  validateIndexState(
    {
      collection: ragConfig.collection,
      corpus_sha256: snapshot.corpus_sha256,
      chunks_sha256: snapshot.chunks_sha256,
      chunk_size: ragConfig.chunk_size,
      chunk_overlap: ragConfig.chunk_overlap,
      embedding_model: ragConfig.embedding_model,
      metric: ragConfig.metric,
      chunk_count: snapshot.chunks.length,
    },
    snapshot,
    ragConfig,
  ),
  [],
);
console.log('Scoring fixtures passed.');
