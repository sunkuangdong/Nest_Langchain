# Evaluation

This directory contains the evaluation protocol, datasets, and immutable
result artifacts for the Nest Langchain Agent system.

## Current Status

The protocol is currently **DRAFT**. No RAG or tool-routing number is official
until the freeze checklist in
[`EVALUATION_SPEC.md`](./EVALUATION_SPEC.md) is complete.

## Planned Layout

```text
evals/
├── EVALUATION_SPEC.md
├── README.md
├── datasets/
│   ├── rag_smoke_v1.jsonl
│   ├── rag_main_v1.jsonl
│   ├── tool_smoke_v1.jsonl
│   └── tool_main_v1.jsonl
└── results/
```

## Planned Next Steps

1. Review and freeze the v1 corpus and retrieval configuration.
2. Create 6-8 RAG smoke cases with stable source and evidence labels.
3. Create 14 balanced tool-routing smoke cases.
4. Implement deterministic dataset and scoring tests.
5. Implement side-effect-free routing mocks.
6. Review main datasets, generate checksums, and freeze protocol v1.
7. Run the official benchmarks without replacing undesirable results.

Voice latency, generated-answer quality, and LLM-as-Judge are not part of the
v1 core evaluation.

No file in this directory contains API credentials.

