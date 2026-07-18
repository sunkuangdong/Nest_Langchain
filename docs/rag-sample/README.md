# RAG sample documents (LangChain official docs)

Sample corpus for testing **Milvus + RAG**. Content is downloaded from LangChain documentation (Markdown sources on docs.langchain.com).

| File | Source | Topic |
|------|--------|--------|
| `01-langchain-rag.md` | [RAG with Deep Agents](https://docs.langchain.com/oss/python/langchain/rag) | RAG patterns, retrieval + generation |
| `02-langchain-retrieval.md` | [Retrieval](https://docs.langchain.com/oss/python/langchain/retrieval) | Retrieval concepts |
| `03-langchain-embeddings.md` | [Embedding integrations](https://docs.langchain.com/oss/python/integrations/text_embedding) | Embedding models |
| `04-langchain-milvus.md` | [Milvus integration](https://docs.langchain.com/oss/python/integrations/vectorstores/milvus) | LangChain ↔ Milvus |

These files are for local RAG experiments only. Prefer the live docs for the latest API.

**Suggested test questions after indexing:**

- What is RAG?
- How does retrieval work in LangChain?
- What is an embedding model used for?
- How do I use Milvus with LangChain?

### Ingest into Milvus

```bash
# From project root; Milvus must be running on localhost:19530
pnpm run rag:ingest:recreate
```

This runs `scripts/rag-ingest.mjs`: chunk markdown → call embedding API → write to collection `MILVUS_COLLECTION` (default `rag_docs`).
