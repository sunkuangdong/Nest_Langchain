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
├── scripts/
│   ├── capture-config.mjs
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
separation, tool argument labels, source paths, and that every RAG evidence
label exists in the fixed corpus. `eval:config` prints model and retrieval
configuration plus dataset hashes without printing API keys or credentials.

Live RAG and routing runners remain a later phase. Before those benchmarks,
the labels must be reviewed and side-effecting tools must be replaced with
schema-compatible mocks.

Voice latency, generated-answer quality, and LLM-as-Judge are not part of the
v1 core evaluation.

No file in this directory contains API credentials.

