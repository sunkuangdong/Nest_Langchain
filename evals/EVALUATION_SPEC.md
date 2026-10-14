# Nest Langchain Evaluation Protocol

- **Status:** DRAFT
- **Version:** 1.0.0
- **Protocol Owner:** Kuangdong Sun
- **Dataset Version:** v1
- **Last Updated:** 2026-10-14

## Objective

This evaluation measures two core capabilities of the voice-interactive Agent
system:

1. Whether the Milvus-backed RAG pipeline retrieves the correct evidence.
2. Whether the model selects the correct tool and produces schema-valid
   arguments without executing side effects during evaluation.

The initial protocol intentionally separates retrieval quality from generated
answer quality and postpones voice-latency evaluation.

## In Scope

### RAG Retrieval

- Source-level Recall@1, Recall@3, and Recall@5
- Mean Reciprocal Rank (MRR)
- Expected-evidence coverage
- P50 and P95 retrieval latency
- A dedicated evaluation collection and fixed ingestion configuration

### Tool Routing

- Seven balanced classes: six tools plus `no_tool`
- Tool-selection accuracy
- Macro precision, recall, and F1
- Argument-schema validity
- No-tool precision and recall
- Per-class results and a confusion matrix
- Schema-compatible mocks for all side-effecting tools

## Out of Scope

- Generated-answer quality and groundedness
- No-answer refusal quality and similarity-threshold tuning
- LLM-as-Judge
- Chunk-size, overlap, embedding-model, or reranking ablations
- Live email delivery, MySQL mutation, or scheduled-job creation
- ASR accuracy
- Time to first token, time to first audio, and end-to-end voice latency
- Model fine-tuning

## Datasets

The v1 datasets are separated into development and benchmark cases:

| Dataset | Size | Purpose | Included in reported benchmark metrics |
| --- | ---: | --- | --- |
| `rag_smoke_v1.jsonl` | 8 | Validate retrieval scoring and labels | No |
| `rag_main_v1.jsonl` | 32 | Official retrieval benchmark | Yes |
| `tool_smoke_v1.jsonl` | 14 | Two development cases per routing class | No |
| `tool_main_v1.jsonl` | 70 | Ten benchmark cases per routing class | Yes |

Smoke cases may be used to fix code and scoring. Once a main benchmark begins,
its cases cannot be used to tune the system and then rerun under the same
benchmark version.

## RAG Case Schema

```json
{
  "id": "rag-001",
  "query": "What is the role of embeddings in RAG?",
  "relevant_sources": [
    "docs/rag-sample/03-langchain-embeddings.md"
  ],
  "expected_evidence": [
    "vector representation",
    "semantic similarity"
  ]
}
```

Source paths and evidence text are stable ground truth. `chunk_index` is not a
permanent label because indexes change when chunking configuration changes.

## RAG Runtime Configuration

The v1 benchmark freezes the following retrieval configuration:

```yaml
collection: rag_docs_eval_v1
chunk_size: 800
chunk_overlap: 120
top_k: 5
metric: COSINE
concurrency: 1
```

The embedding provider, exact embedding model, base URL without credentials,
document commit, vector dimensions, and Milvus version must be captured before
the protocol is frozen.

Changing chunk size, overlap, embedding model, metric, corpus, or reranking
creates a separate benchmark or ablation version. It must not overwrite v1.

## RAG Metrics

- **Source Recall@K:** cases with at least one relevant source in the first K
  hits / all valid retrieval cases
- **MRR:** mean reciprocal rank of the first relevant source
- **Evidence Coverage:** cases where retrieved text contains the case-specific
  expected evidence / all valid retrieval cases
- **Retrieval Latency:** P50 and P95 from embedding request start through
  normalized Milvus results

The initial RAG benchmark contains answerable cases with known source evidence.
No-answer behavior requires a separate threshold and answer-layer protocol.

## Tool-Routing Classes

The benchmark contains ten cases for each class:

1. `knowledge_search`
2. `web_search`
3. `send_mail`
4. `query_user`
5. `db_users_crud`
6. `cron_job`
7. `no_tool`

Each class should include clear, ambiguous, incomplete-argument, and
confusable-intent cases. Paraphrases must not be used merely to inflate the
dataset size.

## Tool Case Schema

```json
{
  "id": "tool-001",
  "query": "Search the local documentation for Milvus indexing.",
  "expected_tool": "knowledge_search",
  "required_arguments": ["query"],
  "forbidden_tools": ["web_search"],
  "side_effect": false
}
```

## Mock and Safety Policy

- The model may emit a tool call, but evaluation tools do not perform real
  side effects.
- `send_mail` never sends an email.
- `db_users_crud` never reads or mutates a real database.
- `cron_job` never creates or modifies a scheduled job.
- User lookup, web search, and knowledge search return deterministic fixture
  results when only routing behavior is under evaluation.
- Mocks preserve production tool names and argument schemas.

## Tool-Routing Metrics

- **Selection Accuracy:** cases with exactly the expected routing decision / all
  valid cases
- **Macro Precision, Recall, and F1:** unweighted mean across all seven classes
- **Schema Validity:** emitted tool calls that pass the expected Zod schema / all
  emitted tool calls
- **No-Tool Precision and Recall:** reported separately
- **Per-Class Accuracy:** reported for each tool and `no_tool`
- **Confusion Matrix:** expected class versus selected class

Selecting the correct tool with invalid required arguments is not a complete
task success. Calling any tool for a `no_tool` case is an incorrect selection.
Selecting multiple tools when the case expects one is also incorrect.

## Model Configuration

The tool-routing benchmark uses a dedicated evaluation configuration:

```yaml
temperature: 0
reasoning_effort: none
concurrency: 1
max_provider_retries: 2
```

Provider, exact model name, base URL without credentials, timeout, and maximum
tool-call steps must be recorded before the protocol is frozen. The benchmark
must not silently inherit a different development temperature.

## Retry and Failure Policy

- Provider rate limits, network timeouts, and provider 5xx errors may be
  retried at most twice.
- A provider failure that remains after retries is recorded as
  `infrastructure_failure`.
- Incorrect retrievals, incorrect routing, invalid tool arguments, and
  unexpected multiple-tool calls are evaluation failures and are not retried.
- Results must not be replaced because their scores are undesirable.

## Reporting

Official results use append-only run directories:

```text
evals/results/<date>_<model>_<dataset>/
├── config.json
├── raw_cases.jsonl
├── summary.json
├── confusion_matrix.json
└── report.md
```

Each result set records the protocol version, dataset version and checksum,
Git commit, provider, model, runtime configuration, and run date. Summary files
must be reproducible from raw case results.

## Limitations

- Source-level retrieval relevance does not establish that a generated answer
  is factually correct or fully grounded.
- Keyword/evidence coverage is a deterministic proxy and can miss semantically
  equivalent wording.
- Seventy routing cases provide portfolio-scale evidence but do not constitute
  a production traffic distribution or service-level guarantee.
- Hosted models and embedding services may change behavior without a local code
  change.
- Voice latency and speech quality are intentionally excluded from v1.

## Change Policy

- Documentation-only corrections that do not change meaning increment the
  patch version.
- Label, scoring, and individual-case changes increment the minor version and
  require affected results to be rerun.
- Changes to scope, corpus, retrieval configuration, model, core prompt, or
  class definitions require a new major benchmark version.
- Previous protocols, datasets, and raw results must be preserved.
- Prompt changes after benchmark review require a new holdout dataset or
  benchmark version.

## Freeze Checklist

The status may change from `DRAFT` to `FROZEN` only when:

- [ ] RAG and tool-routing smoke datasets have been reviewed.
- [ ] Main datasets and labels have been reviewed.
- [ ] Development and main cases are disjoint.
- [ ] The evaluation corpus and collection are fixed.
- [ ] Provider, model, embedding model, timeout, and retry values are recorded.
- [ ] All side-effecting tools are replaced with verified mocks.
- [ ] Scoring rules pass manually verifiable fixture cases.
- [ ] Dataset SHA-256 checksums are generated.
- [ ] The protocol and datasets are committed and tagged.

