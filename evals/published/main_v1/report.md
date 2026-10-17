# Frozen Agent Evaluation Benchmark

- Protocol: `1.2.0`
- Freeze tag: `eval-protocol-v1.2.0`
- Freeze commit: `ad4b6a213f2a32cab82cf96c3e18e66bc92a5dd4`
- Evaluated cases: 102
- Infrastructure failures: 0

## RAG Retrieval

| Metric | Result |
| --- | ---: |
| Cases | 32 |
| Recall@1 | 90.6% |
| Recall@3 | 100.0% |
| Recall@5 | 100.0% |
| MRR | 0.9375 |
| Mean evidence coverage | 81.8% |
| Full evidence coverage | 78.1% |
| P50 latency | 200 ms |
| P95 latency | 1159 ms |

All 32 labeled queries retrieved a relevant source within the first three
results. Recall@1 misses were limited to: `rag-main-003`, `rag-main-020`, `rag-main-021`.
Evidence coverage was incomplete for 7 cases:
`rag-main-003`, `rag-main-005`, `rag-main-006`, `rag-main-008`, `rag-main-009`, `rag-main-010`, `rag-main-027`.

## Tool Routing

| Metric | Result |
| --- | ---: |
| Cases | 70 |
| Selection accuracy | 98.6% |
| Macro F1 | 98.6% |
| Routing task success | 97.1% |
| Schema validity | 100.0% |
| Exact argument match | 97.7% |
| P50 latency | 1208 ms |
| P95 latency | 1849 ms |

The routing benchmark used seven balanced classes with ten cases per class.
No side-effecting tool was executed. Unsuccessful routing tasks were:
`tool-main-017`, `tool-main-056`.

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
