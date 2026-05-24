/**
 * OpenAI ASR (Whisper) — transcribe a local audio file (Node 18+).
 *
 * Usage:
 *   node src/tts_and_stt/asr-test.mjs
 *   node src/tts_and_stt/asr-test.mjs files/audio/streaming-output.mp3
 *   pnpm run asr:test
 *
 * .env: OPENAI_API_KEY, OPENAI_BASE_URL (optional, default api.openai.com/v1)
 * Optional: ASR_MODEL (default whisper-1), ASR_LANGUAGE (e.g. zh)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const baseURL = (
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
).replace(/\/$/, '');

const model = process.env.ASR_MODEL || 'whisper-1';
const language = process.env.ASR_LANGUAGE;

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const audioFile =
  cliArgs[0] || path.join(process.cwd(), 'files/audio/streaming-output.mp3');

if (!fs.existsSync(audioFile)) {
  console.error(`Audio file not found: ${audioFile}`);
  process.exit(1);
}

const audioBuffer = fs.readFileSync(audioFile);
const formData = new FormData();
formData.append('file', new Blob([audioBuffer]), path.basename(audioFile));
formData.append('model', model);
if (language) {
  formData.append('language', language);
}

const response = await fetch(`${baseURL}/audio/transcriptions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
  },
  body: formData,
});

if (!response.ok) {
  const errText = await response.text();
  console.error(`ASR failed (${response.status}):`, errText);
  process.exit(1);
}

const data = await response.json();
console.log('Recognition result:', data.text ?? data);
