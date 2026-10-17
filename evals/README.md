# Evaluation

This directory contains the evaluation protocol, datasets, and immutable
result artifacts for the Nest Langchain Agent system.

## Current Status

The protocol is currently **DRAFT**. No RAG or tool-routing number is official
until the freeze checklist in
[`EVALUATION_SPEC.md`](./EVALUATION_SPEC.md) is complete.

## Layout

```text
evals/
├── EVALUATION_SPEC.md
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

The live RAG runner remains a later phase. Main routing results are not official
until the labels, fixed prompt, and Smoke output have been reviewed and the
protocol has been frozen.

Voice latency, generated-answer quality, and LLM-as-Judge are not part of the
v1 core evaluation.

No file in this directory contains API credentials.
