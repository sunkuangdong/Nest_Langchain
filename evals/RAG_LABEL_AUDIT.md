# RAG Label Audit

- Audit date: 2026-10-16
- Protocol: 1.2.0-draft
- Corpus: four Markdown files under `docs/rag-sample`
- Datasets reviewed: 8 Smoke cases and 32 Main cases

## Relevance Rule

A document is a relevant source only when it can independently support the
question's core answer. A topic mention, navigation link, or isolated shared
term is insufficient. Expected-evidence phrases remain deterministic content
checks and do not replace semantic source review.

## Method

1. Search every expected-evidence phrase across all four corpus documents.
2. Review queries with shared RAG, retrieval, embedding, vector-store, hybrid,
   and BM25 terminology for semantically equivalent evidence.
3. Add every document that independently supports the core answer.
4. Retain a single source where another document only mentions the topic or
   supports one incidental term.

## Changes

| Case | Added source | Reason |
| --- | --- | --- |
| `rag-smoke-001` | `02-langchain-retrieval.md` | Independently defines RAG as retrieval integrated with generation. |
| `rag-main-009` | `01-langchain-rag.md` | Independently describes load, split, embed, and vector-store indexing stages. |
| `rag-main-010` | `01-langchain-rag.md` | Independently explains chunking for finite context windows and searchability. |

No additional source was added to the remaining 30 Main cases. In particular,
the Milvus document's RAG links do not define RAG, and its BM25 discussion does
not independently explain the identifier-specific dense-retrieval weakness in
`rag-main-020`.
