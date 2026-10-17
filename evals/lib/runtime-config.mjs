import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sanitizeEndpoint(rawValue, fallback) {
  const url = new URL((rawValue || fallback).trim());
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function inferProvider(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === 'api.openai.com' || host.endsWith('.openai.com'))
    return 'openai';
  if (host.includes('dashscope') || host.endsWith('aliyuncs.com'))
    return 'dashscope';
  return 'openai-compatible';
}

export function fileSha256(filename) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filename))
    .digest('hex');
}

function gitCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function captureRuntimeConfig(root, datasetPaths = []) {
  const modelBaseUrl = sanitizeEndpoint(
    process.env.OPENAI_BASE_URL,
    'https://api.openai.com/v1',
  );
  const modelName = (process.env.MODEL_NAME || 'gpt-6-luna').trim();
  const embeddingModel =
    process.env.EMBEDDING_MODEL ||
    (modelBaseUrl.includes('dashscope') || modelBaseUrl.includes('aliyuncs.com')
      ? 'text-embedding-v3'
      : 'text-embedding-3-small');
  return {
    protocol_version: '1.2.0-draft',
    dataset_version: 'v1',
    git_commit: gitCommit(root),
    provider: inferProvider(modelBaseUrl),
    model_name: modelName,
    model_base_url: modelBaseUrl,
    reasoning_effort: (process.env.MODEL_REASONING_EFFORT || 'none').trim(),
    temperature: 0,
    timeout_seconds: Number(process.env.EVAL_TIMEOUT_SECONDS || 120),
    max_provider_retries: Number(process.env.MODEL_MAX_RETRIES || 2),
    max_tool_call_steps: Number(process.env.EVAL_MAX_TOOL_STEPS || 4),
    retrieval: {
      collection: process.env.EVAL_MILVUS_COLLECTION || 'rag_docs_eval_v1',
      chunk_size: Number(process.env.EVAL_RAG_CHUNK_SIZE || 800),
      chunk_overlap: Number(process.env.EVAL_RAG_CHUNK_OVERLAP || 120),
      top_k: Number(process.env.EVAL_RAG_TOP_K || 5),
      metric: 'COSINE',
      embedding_model: embeddingModel,
      concurrency: 1,
    },
    datasets: datasetPaths.map((datasetPath) => ({
      path: path.relative(root, datasetPath),
      sha256: fileSha256(datasetPath),
    })),
  };
}
