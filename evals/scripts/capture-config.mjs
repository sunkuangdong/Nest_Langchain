import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { captureRuntimeConfig } from '../lib/runtime-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const datasetDir = path.join(ROOT, 'evals/datasets');
const datasetPaths = fs
  .readdirSync(datasetDir)
  .filter((name) => name.endsWith('.jsonl'))
  .sort()
  .map((name) => path.join(datasetDir, name));

console.log(JSON.stringify(captureRuntimeConfig(ROOT, datasetPaths), null, 2));
