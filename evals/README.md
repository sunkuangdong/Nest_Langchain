# Evaluation

This directory contains the evaluation protocol, datasets, and immutable
result artifacts for the Nest Langchain Agent system.

## Current Status

Evaluation protocol v1.2.0 is **FROZEN** at Git tag
`eval-protocol-v1.2.0`. Official v1 benchmark runs must use that tag and the
checksums recorded in [`EVALUATION_SPEC.md`](./EVALUATION_SPEC.md). Any change
to a frozen dataset, label, prompt, scoring rule, model, corpus, or retrieval
configuration must follow the protocol's change policy and use a new version.

## Layout

```text
evals/
├── EVALUATION_SPEC.md
├── RAG_LABEL_AUDIT.md
├── README.md
├── datasets/
│   ├── rag_smoke_v1.jsonl
│   ├── rag_main_v1.jsonl
│   ├── tool_smoke_v1.jsonl
│   └── tool_main_v1.jsonl
├── lib/
│   ├── runtime-config.mjs
│   └── scoring.mjs
├── prompts/
│   └── tool-routing-v1.txt
├── scripts/
│   ├── capture-config.mjs
│   ├── ingest-rag-eval.mjs
│   ├── run-rag-retrieval.mjs
│   ├── run-tool-routing.mjs
│   ├── test-scoring.mjs
│   └── validate-datasets.mjs
└── results/
```

## Local Validation

Use Node.js 22, matching the application runtime:

```bash
nvm use 22
pnpm eval:validate
pnpm eval:test
pnpm eval:config
```

`eval:validate` verifies dataset sizes, balanced routing classes, smoke/main
separation, required and deterministic tool argument labels, source paths, and
that every RAG evidence label exists in the fixed corpus. `eval:config` prints
model and retrieval configuration plus dataset hashes without printing API keys
or credentials.

Tool-routing v1 covers single-turn, fully specified requests. The main set
contains confusable-but-answerable pairs; requests that genuinely require a
clarification turn are reserved for a future benchmark with an explicit
`clarify` expectation.

## Tool-Routing Runner

The runner sends one system message and one benchmark query to the configured
model, records its first routing decision, and stops before executing any tool.
It exposes schema-compatible Mock tools, so it cannot send email, query or
mutate MySQL, change scheduled jobs, call Bocha, or access Milvus.

Validate the command and resolved configuration without making an API call:

```bash
pnpm eval:tool:smoke -- --dry-run
```

Run the 14-case Smoke dataset:

```bash
pnpm eval:tool:smoke
```

Use repeated `--case-id` options to select individual cases. Generated run
directories under `evals/results/` contain `config.json`, `raw_cases.jsonl`,
`summary.json`, `confusion_matrix.json`, and `report.md`; they are ignored by
Git by default.

## RAG Retrieval Runner

The RAG benchmark uses the fixed `docs/rag-sample` corpus and a dedicated
Milvus collection. Evaluation scripts reject collection names that do not
start with `rag_docs_eval_`, so they cannot overwrite the production
`rag_docs` collection. Index metadata and corpus hashes are written to the
Git-ignored `evals/state/` directory.

Validate the corpus and resolved indexing configuration without calling the
embedding provider or Milvus:

```bash
pnpm eval:rag:ingest -- --dry-run
```

Create the evaluation index. If the collection already exists and must be
rebuilt, add the explicit `--recreate` option; the default command refuses to
append duplicate vectors:

```bash
pnpm eval:rag:ingest
pnpm eval:rag:ingest -- --recreate
```

Check whether the local corpus, configuration, and saved index state still
match, then run the eight-case Smoke dataset:

```bash
pnpm eval:rag:smoke -- --dry-run
pnpm eval:rag:smoke
```

The runner records source-level Recall@1/3/5, MRR, mean and full expected-
evidence coverage, embedding-through-search P50/P95 latency, query embedding
token usage, and per-case Top-K hits. Infrastructure failures are reported but
excluded from retrieval-quality aggregates.

Main RAG and routing results are official only when they use the frozen
protocol, pass configuration and dataset-hash validation, and retain their raw
case results. Smoke results remain development evidence and are not included in
reported Main benchmark metrics.

## Publishing Frozen Main Results

The publisher accepts one frozen RAG Main run and one frozen Tool Main run. It
rejects draft protocol versions, non-tagged commits, unexpected dataset hashes,
partial datasets, changed model/retrieval settings, and tool runs that enabled
side effects. Published case files omit retrieved text, assistant text, and tool
arguments while retaining the measurements needed to audit aggregate metrics.

```bash
pnpm eval:publish -- \
  --rag-dir evals/results/<rag-main-run> \
  --tool-dir evals/results/<tool-main-run> \
  --output-dir evals/published/main_v1
```

The tracked report is written to `evals/published/main_v1/report.md` together
with its aggregate summary and sanitized per-case evidence.

Voice latency, generated-answer quality, and LLM-as-Judge are not part of the
v1 core evaluation.

No file in this directory contains API credentials.
