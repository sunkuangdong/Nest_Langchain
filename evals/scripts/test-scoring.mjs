import assert from 'node:assert/strict';
import { sanitizeEndpoint } from '../lib/runtime-config.mjs';
import { scoreRagCase, scoreToolCases } from '../lib/scoring.mjs';

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
    },
    { id: 'two', expected_tool: 'no_tool', required_arguments: [] },
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

const endpoint = sanitizeEndpoint(
  'https://user:secret@example.com:8443/v1?api_key=secret#fragment',
  'https://api.openai.com/v1',
);
assert.equal(endpoint, 'https://example.com:8443/v1');
assert.equal(endpoint.includes('secret'), false);
console.log('Scoring fixtures passed.');
