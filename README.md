# Nest LangChain Demo

This is a demo project built with `NestJS` + `LangChain`, including:

- Standard chat endpoint: `/ai/chat`
- Streaming chat endpoint (SSE): `/ai/chat/stream`
- Browser test page: `/sse-test.html`

## 1. Requirements

- Node.js `>= 18`
- npm `>= 9`

## 2. Install Dependencies

```bash
npm install
```

## 3. Configure Environment Variables

Create a `.env` file in the project root and fill in your own values (do not commit secrets). Copy the template below, then adjust each line for your environment.

**Required (chat / agents will not start without these):**

```env
OPENAI_BASE_URL=https://your-compatible-api.example/v1
OPENAI_API_KEY=your_api_key
MODEL_NAME=your_model_name
```

**Optional (enable only the tools you need):**

```env
# Server port (default 3000)
PORT=3000

# send_mail tool — SMTP (see app.module MailerModule)
MAIL_HOST=smtp.example.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USER=your_smtp_user
MAIL_PASS=your_smtp_password
MAIL_FROM=noreply@example.com

# web_search tool — Bocha Web Search API (https://open.bochaai.com/)
BOCHA_API_KEY=your_bocha_api_key
```

**MySQL (for `db_users_crud` and `cron_job` jobs):** the app connects to a local MySQL database named `hello` (see `src/app.module.ts` TypeORM settings: host `localhost`, user `root`, empty password by default). Start MySQL and create the database before running the app, or change the TypeORM config to match your setup.


| Variable          | Required                 | Used by           |
| ----------------- | ------------------------ | ----------------- |
| `OPENAI_BASE_URL` | Yes                      | LLM / all agents  |
| `OPENAI_API_KEY`  | Yes                      | LLM / all agents  |
| `MODEL_NAME`      | No (default `qwen-plus`) | LLM / all agents  |
| `PORT`            | No (default `3000`)      | HTTP server       |
| `MAIL_`*          | No                       | `send_mail` tool  |
| `BOCHA_API_KEY`   | No                       | `web_search` tool |


## 4. Start the Project

```bash
npm run start:dev
```

After startup, the server listens on `http://localhost:3000` by default.

## 5. Open the Page in Browser

Open:

- [http://localhost:3000/sse-test.html](http://localhost:3000/sse-test.html)

This is a frontend test page where you can enter a prompt and view streaming output in real time.

## 6. Quick API Checks

### Standard Chat Endpoint

- [http://localhost:3000/ai/chat?query=Hello](http://localhost:3000/ai/chat?query=Hello)

### Streaming Endpoint (recommended via curl)

```bash
curl -N -G --data-urlencode "query=Tell me what NestJS is" "http://localhost:3000/ai/chat/stream"
```

## FAQ

- Page cannot be opened: make sure the server is running and your terminal shows `Nest application successfully started`.
- No model response: verify `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `MODEL_NAME` in `.env`.
- Garbled text in streaming page: use `sse-test.html` or `curl -N`; do not open the SSE endpoint directly as a normal web page.

---

## Current Version — AI Agent, Tools & Scheduled Jobs

This release extends the NestJS + LangChain demo into a tool-using chat agent and a MySQL-backed job scheduler. Use the links below (same style as **§5–§6** above) to open pages and APIs in the browser after `npm run start:dev`. The chat agent can invoke LangChain tools for user lookup, email, web search, MySQL user CRUD, server time, and `cron_job` scheduling. Jobs persist in MySQL and are re-registered on startup by `JobService` using `@nestjs/schedule`. Scheduled ticks currently log the instruction only; use the job-agent URL below to test background LLM execution.

### Quick links (this version)

**Browser test pages**

- [http://localhost:3000/sse-test.html](http://localhost:3000/sse-test.html) — recommended UI (stream + full JSON reply)
- [http://localhost:3000/sse.html](http://localhost:3000/sse.html) — alternate SSE chat page

**HTTP APIs**

- [http://localhost:3000/ai/chat?query=Hello](http://localhost:3000/ai/chat?query=Hello) — non-streaming chat (JSON `{ answer }`)
- [http://localhost:3000/ai/job-agent/run?instruction=Call+time_now+and+summarize](http://localhost:3000/ai/job-agent/run?instruction=Call+time_now+and+summarize) — run `JobAgentService` once (JSON `{ result }`)

**Streaming (use curl, not the browser address bar)**

```bash
curl -N -G --data-urlencode "query=Tell me what NestJS is" "http://localhost:3000/ai/chat/stream"
```

**Example tool prompts** (paste into [sse-test.html](http://localhost:3000/sse-test.html); each request is single-turn):

- Cron list: `Use cron_job with action=list`
- Cron add: `Use cron_job to add a job: type=every, everyMs=60000, instruction=remind me to drink water`
- Web search: `Use web_search for 2026 AI trends and summarize in one sentence`

### Summary — capabilities in this version


| Area                 | Capability                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chat**             | Non-streaming and SSE streaming replies driven by an OpenAI-compatible model with multi-round tool calling.                                                                                                        |
| **Tools (chat)**     | `query_user` (in-memory users), `send_mail` (SMTP via `@nestjs-modules/mailer`), `web_search` (Bocha API), `db_users_crud` (MySQL `user` table), `cron_job` (list / add / toggle jobs), `time_now` (server clock). |
| **Jobs**             | Persist `every` / `cron` / `at` jobs in MySQL; register with `@nestjs/schedule` (`SchedulerRegistry`); re-enable on app bootstrap; manage jobs through natural language + `cron_job` tool.                         |
| **Background agent** | `JobAgentService` runs a focused agent loop (`send_mail`, `web_search`, `db_users_crud`, `time_now`) for a one-off instruction — dev endpoint: `GET /ai/job-agent/run?instruction=...`.                            |
| **Static UI**        | `public/sse-test.html` served at `/sse-test.html`.                                                                                                                                                                 |
| **Data**             | TypeORM + MySQL (`hello` database, `user` and `job` entities, `synchronize: true`).                                                                                                                                |