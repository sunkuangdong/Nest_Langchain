/**
 * OpenAI TTS — HTTP streaming (Node 18+).
 *
 * Sends each sentence in TEXTS with a delay (similar demo to Tencent WS flow),
 * streams each /audio/speech response body into one mp3 file.
 *
 * Usage:
 *   node src/tts_and_stt/streaming-tts-test.mjs
 *   pnpm run tts:stream
 *
 * .env: OPENAI_API_KEY, OPENAI_BASE_URL (optional)
 * Optional: TTS_MODEL (tts-1), TTS_VOICE (alloy)
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

const model = process.env.TTS_MODEL || 'tts-1';
const voice = process.env.TTS_VOICE || 'alloy';

const SLEEP_INTERVAL_MS = 3000;
const TEXTS = [
  '傍晚我还在为晚霞开心，',
  '突然接到电话说系统崩了，',
  '我心里一沉冲回办公室，',
  '好在大家一起排查后终于恢复，',
  '我长长松了口气。',
];

const filesDir = path.join(process.cwd(), 'files/audio');
fs.mkdirSync(filesDir, { recursive: true });
const OUTPUT_FILE = path.join(filesDir, 'streaming-output.mp3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamSpeechToWriter(input, writeStream) {
  const response = await fetch(`${baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input, voice }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`TTS failed (${response.status}): ${errText}`);
  }

  if (!response.body) {
    throw new Error(
      'Response body is empty (streaming not supported by this endpoint)',
    );
  }

  const reader = response.body.getReader();
  let chunkBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(Buffer.from(value));
    chunkBytes += value.length;
  }

  return chunkBytes;
}

async function streamTTS() {
  const writeStream = fs.createWriteStream(OUTPUT_FILE, { flags: 'w' });
  let totalBytes = 0;

  const done = new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  try {
    for (let i = 0; i < TEXTS.length; i++) {
      const line = TEXTS[i];
      console.log(`[text] sending (${i + 1}/${TEXTS.length}): ${line}`);
      const bytes = await streamSpeechToWriter(line, writeStream);
      totalBytes += bytes;
      console.log(`[stream] received ${bytes} bytes for this sentence`);

      if (i < TEXTS.length - 1) {
        await sleep(SLEEP_INTERVAL_MS);
      }
    }
  } catch (err) {
    writeStream.destroy();
    console.error('[error]', err.message || err);
    process.exit(1);
  }

  writeStream.end();
  await done;
  console.log(`[saved] ${OUTPUT_FILE} (${totalBytes} bytes total)`);
}

streamTTS();
