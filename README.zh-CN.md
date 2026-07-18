# NestJS + LangChain Agent 演示

[English](./README.md) | 中文

全栈 AI Agent 演示：后端为 NestJS + LangChain，主界面为语音聊天页（`asr.html`）。可选 AGUI React 前端用于富工具展示。

### 主要能力

- **后端 Agent**：NestJS + LangChain 工具调用循环（普通聊天、SSE 流式、AGUI Data Stream）。
- **语音界面**：[`public/asr.html`](./public/asr.html) — ASR → Agent 对话 → WebSocket TTS。根路径 `/` 会重定向到此页。
- **RAG**：Milvus 向量库 + `knowledge_search` 工具，语料见 [`docs/rag-sample/`](./docs/rag-sample/)。
- **可选 AGUI**：React + Vite（`agui-frontend/`），对接 Vercel AI SDK Data Stream Protocol。

## 1. 架构与技术

![架构图](./public/architecture.svg)

### 技术栈

**后端（NestJS）**

- **框架**：[NestJS](https://nestjs.com/)
- **AI/Agent**：[LangChain](https://js.langchain.com/)（`bindTools` / `createAgent`）
- **业务库**：TypeORM + **MySQL**（`user` / `job`）— 配置在 `src/app.module.ts`（`localhost:3306`，`root`，空密码，库名 `hello`）
- **RAG 库**：**Milvus** 存储文档向量（默认集合 `rag_docs`）
- **工具**（已在 `AiService` 接入）：
  - `knowledge_search` — 本地 Milvus RAG（LangChain / RAG / embeddings 相关问题优先用）
  - `web_search` — 博查 API
  - `send_mail` — SMTP（`@nestjs-modules/mailer`）
  - `query_user` — 本地模拟用户查询
  - `db_users_crud` — MySQL 用户 CRUD
  - `cron_job` — 定时任务（`@nestjs/schedule`）

**主界面**

- 语音聊天：[http://localhost:3000/asr.html](http://localhost:3000/asr.html)

**可选前端（AGUI）**

- React + Vite + Tailwind（`agui-frontend/`）
- `@ai-sdk/react`（`useChat`）+ `streamdown`

---

## 2. 快速开始

### 步骤 2.1：配置环境变量

将 [`.env.example`](./.env.example) 复制为 `.env` 并填写：

```env
# --- 必填：LLM ---
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_llm_api_key_here
MODEL_NAME=gpt-4o-mini

# --- 可选：服务端口（默认 3000）---
PORT=3000

# --- 可选：联网搜索（博查）---
BOCHA_API_KEY=your_bocha_api_key_here

# --- 可选：发信（SMTP）---
MAIL_HOST=smtp.example.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USER=your_email@example.com
MAIL_PASS=your_email_password
MAIL_FROM=your_email@example.com

# --- Milvus（RAG）---
MILVUS_ADDRESS=localhost:19530
MILVUS_COLLECTION=rag_docs
MILVUS_USER=
MILVUS_PASSWORD=
# 需与 OPENAI_BASE_URL 对应的提供商一致
# OpenAI: text-embedding-3-small | 通义 DashScope: text-embedding-v3
EMBEDDING_MODEL=text-embedding-3-small
RAG_DOCS_PATH=docs/rag-sample
RAG_TOP_K=4
RAG_CHUNK_SIZE=800
RAG_CHUNK_OVERLAP=120
RAG_EMBED_BATCH=16
```

**说明**

- MySQL 连接写死在 `src/app.module.ts` 中（**不**从 `.env` 读取）。若 Docker MySQL 也占用 `:3306`，请优先使用 Homebrew/本机 MySQL（`127.0.0.1`），或停掉冲突容器（`docker stop mysql-prod`）。
- Milvus 只存 RAG 向量；业务数据在 MySQL。

### 步骤 2.1b：RAG — 入库与校验

1. 启动 Milvus Docker：`milvus-standalone`、`milvus-etcd`、`milvus-minio`（端口 `19530`）。
2. 确认 `.env` 中 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `EMBEDDING_MODEL` 可用。
3. 导入样例文档：

```bash
pnpm run rag:ingest:recreate   # 重建集合
# 或
pnpm run rag:ingest            # 追加写入
```

4. 验证检索：

```bash
pnpm run rag:search -- "What is RAG?"
```

脚本：[`scripts/rag-ingest.mjs`](./scripts/rag-ingest.mjs)、[`scripts/rag-search.mjs`](./scripts/rag-search.mjs)。  
运行时 Agent 通过 [`MilvusRagService`](./src/rag/milvus-rag.service.ts) 调用 `knowledge_search`。

### 步骤 2.2：启动后端

```bash
pnpm install
pnpm run start:dev
```

后端地址：`http://localhost:3000`

### 步骤 2.3：打开应用

打开 **[http://localhost:3000/asr.html](http://localhost:3000/asr.html)**（或访问 `http://localhost:3000/`，会重定向到此页）。

可问 RAG 相关问题（例如 “What is RAG?”）以验证 `knowledge_search`。

**可选 — AGUI React 界面：**

```bash
cd agui-frontend
pnpm install
pnpm run dev
```

然后打开 [http://localhost:5173](http://localhost:5173)。

**无界面快速验证：**

```bash
curl 'http://localhost:3000/ai/chat?query=What%20is%20RAG%3F'
```

---

## 3. 免责声明

**免责声明**：本项目仅供学习与演示。

- 未经安全评审、完善的错误处理与访问控制，请勿直接用于生产环境。
- 部分工具（尤其是 `send_mail`、`db_users_crud`）会执行真实操作，将能力暴露给 LLM 时请谨慎。
- 因使用第三方 API（如 OpenAI、博查等）产生的误用、数据丢失或意外费用，作者不承担责任。
