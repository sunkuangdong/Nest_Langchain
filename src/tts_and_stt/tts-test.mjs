/**
 * OpenAI TTS quick test (Node 18+).
 *
 * Usage:
 *   node src/tts_and_stt/tts-test.mjs "Hello, this is a test."
 *   node src/tts_and_stt/tts-test.mjs "Hello, TTS test" ./out.mp3
 *   pnpm run tts:test "Hello"              (do not use extra "--" before the text)
 *   pnpm run tts:test "Hello" ./out.mp3
 * Default output: files/tts-output.mp3 (project root /files)
 *
 * .env: OPENAI_API_KEY, OPENAI_BASE_URL (optional, default api.openai.com/v1)
 * Optional: TTS_MODEL (default tts-1), TTS_VOICE (default alloy)
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

// pnpm run tts:test -- "text" inserts a literal "--" in argv; strip it
const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const text = cliArgs[0] || 'Hello from OpenAI text-to-speech.';

const filesDir = path.join(process.cwd(), 'files/audio');
fs.mkdirSync(filesDir, { recursive: true });

function resolveOutputPath(userArg) {
  let target = userArg || 'tts-output.mp3';
  const hasPathSep = target.includes('/') || target.includes('\\');
  if (!path.isAbsolute(target) && !hasPathSep) {
    target = path.join(filesDir, target);
  } else if (!path.isAbsolute(target)) {
    target = path.resolve(process.cwd(), target);
  }
  if (!/\.\w+$/i.test(target)) {
    target = `${target}.mp3`;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

const outputPath = resolveOutputPath(cliArgs[1]);
const model = process.env.TTS_MODEL || 'tts-1';
const voice = process.env.TTS_VOICE || 'alloy';

const response = await fetch(`${baseURL}/audio/speech`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model,
    input: text,
    voice,
  }),
});

if (!response.ok) {
  const errText = await response.text();
  console.error(`TTS failed (${response.status}):`, errText);
  process.exit(1);
}

const audio = Buffer.from(await response.arrayBuffer());
fs.writeFileSync(outputPath, audio);
console.log(`Saved ${outputPath} (${audio.length} bytes)`);
