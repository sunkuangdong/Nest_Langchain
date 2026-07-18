# NestJS + LangChain Agent Demo

English | [中文](./README.zh-CN.md)

Full-stack AI Agent demo: NestJS + LangChain on the backend, with a voice chat page (`asr.html`) as the primary UI. Optional AGUI React frontend for rich tool rendering.

### Key Features

- **Backend Agent**: NestJS + LangChain tool-calling loop (chat, SSE stream, AGUI data stream).
- **Voice UI**: [`public/asr.html`](./public/asr.html) — ASR → agent chat → TTS over WebSocket. Root `/` redirects here.
- **RAG**: Milvus vector store + `knowledge_search` tool, grounded on [`docs/rag-sample/`](./docs/rag-sample/).
- **Optional AGUI**: React + Vite (`agui-frontend/`) with Vercel AI SDK Data Stream Protocol.

## 1. Architecture & Technologies

![Architecture Diagram](./public/architecture.svg)

### Tech Stack

**Backend (NestJS)**

- **Framework**: [NestJS](https://nestjs.com/)
- **AI/Agent**: [LangChain](https://js.langchain.com/) (`bindTools` / `createAgent`)
- **Business DB**: TypeORM + **MySQL** (`user` / `job`) — configured in `src/app.module.ts` (`localhost:3306`, `root`, empty password, database `hello`)
- **RAG DB**: **Milvus** for document embeddings (`rag_docs` collection by default)
- **Tools** (wired in `AiService`):
  - `knowledge_search` — local Milvus RAG (prefer for LangChain / RAG / embeddings docs)
  - `web_search` — Bocha API
  - `send_mail` — SMTP via `@nestjs-modules/mailer`
  - `query_user` — mock local users
  - `db_users_crud` — MySQL user CRUD
  - `cron_job` — scheduled jobs via `@nestjs/schedule`

**Primary UI**

- Voice chat: [http://localhost:3000/asr.html](http://localhost:3000/asr.html)

**Optional frontend (AGUI)**

- React + Vite + Tailwind (`agui-frontend/`)
- `@ai-sdk/react` (`useChat`) + `streamdown`

---

## 2. Getting Started

### Step 2.1: Configure Environment Variables

Copy [`.env.example`](./.env.example) to `.env` and fill in values:

```env
# --- Required: LLM Configuration ---
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_llm_api_key_here
MODEL_NAME=gpt-4o-mini

# --- Optional: Server Port (Default 3000) ---
PORT=3000

# --- Optional: Web Search Tool (Bocha API) ---
BOCHA_API_KEY=your_bocha_api_key_here

# --- Optional: Send Mail Tool (SMTP) ---
MAIL_HOST=smtp.example.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USER=your_email@example.com
MAIL_PASS=your_email_password
MAIL_FROM=your_email@example.com

# --- Milvus (RAG) ---
MILVUS_ADDRESS=localhost:19530
MILVUS_COLLECTION=rag_docs
MILVUS_USER=
MILVUS_PASSWORD=
# Must match your OPENAI_BASE_URL provider
# OpenAI: text-embedding-3-small | DashScope: text-embedding-v3
EMBEDDING_MODEL=text-embedding-3-small
RAG_DOCS_PATH=docs/rag-sample
RAG_TOP_K=4
RAG_CHUNK_SIZE=800
RAG_CHUNK_OVERLAP=120
RAG_EMBED_BATCH=16
```

**Notes**

- MySQL connection is **hardcoded** in `src/app.module.ts` (not read from `.env`). If Docker MySQL also binds `:3306`, prefer Homebrew/local MySQL on `127.0.0.1`, or stop the conflicting container (`docker stop mysql-prod`).
- Milvus holds RAG vectors only; MySQL holds business data.

### Step 2.1b: RAG — ingest & verify

1. Start Milvus Docker: `milvus-standalone`, `milvus-etcd`, `milvus-minio` (port `19530`).
2. Ensure `.env` has a working `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `EMBEDDING_MODEL`.
3. Ingest sample docs:

```bash
pnpm run rag:ingest:recreate   # rebuild collection
# or
pnpm run rag:ingest            # append
```

4. Verify search:

```bash
pnpm run rag:search -- "What is RAG?"
```

Scripts: [`scripts/rag-ingest.mjs`](./scripts/rag-ingest.mjs), [`scripts/rag-search.mjs`](./scripts/rag-search.mjs).  
At runtime the agent calls `knowledge_search` via [`MilvusRagService`](./src/rag/milvus-rag.service.ts).

### Step 2.2: Start the Backend

```bash
pnpm install
pnpm run start:dev
```

Backend: `http://localhost:3000`

### Step 2.3: Open the App

Open **[http://localhost:3000/asr.html](http://localhost:3000/asr.html)** (or `http://localhost:3000/` — redirects there).

Ask RAG-related questions (e.g. “What is RAG?”) to exercise `knowledge_search`.

**Optional — AGUI React UI:**

```bash
cd agui-frontend
pnpm install
pnpm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

**Quick API check (no UI):**

```bash
curl 'http://localhost:3000/ai/chat?query=What%20is%20RAG%3F'
```

---

## 3. Disclaimer

**Disclaimer**: This project is provided for educational and demonstration purposes only.

- Do not use this code in a production environment without proper security reviews, error handling, and access controls.
- The tools provided (especially `send_mail` and `db_users_crud`) can perform real actions. Please be cautious when exposing these capabilities to an LLM.
- The authors are not responsible for any misuse, data loss, or unexpected charges incurred from third-party APIs (like OpenAI or Bocha) while using this software.
