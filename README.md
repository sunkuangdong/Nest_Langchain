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

Create a `.env` file in the project root (you can reuse your existing one).  
At minimum, set:

```env
OPENAI_BASE_URL=your compatible API base URL
OPENAI_API_KEY=your API key
MODEL_NAME=your model name
```

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
