#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_URL = 'https://quickwowtalents.com/api/addon-data';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'QuickWoWTalents', 'QuickWoWTalentsData.lua');

function readArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function assertLooksLikeAddonLua(text) {
  if (!/^QuickWoWTalentsData = /m.test(text)) {
    throw new Error('Downloaded addon data is not a QuickWoWTalentsData Lua assignment.');
  }
  if (!/recommendations = \{/.test(text)) {
    throw new Error('Downloaded addon data does not include recommendations.');
  }
  if (!/schemaVersion = 2/.test(text)) {
    throw new Error('Downloaded addon data does not use schemaVersion 2.');
  }
}

async function downloadAddonData({ url, outputPath, timeoutMs }) {
  const response = await fetch(url, {
    signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: {
      accept: 'text/plain',
      'user-agent': 'quickwowtalents-addon-release/0.2'
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  assertLooksLikeAddonLua(text);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');

  return {
    outputPath,
    bytes: Buffer.byteLength(text),
    recommendations: Number(text.match(/counts = \{[\s\S]*?recommendations = (\d+)/)?.[1] ?? 0),
    generatedAt: text.match(/generatedAt = "([^"]+)"/)?.[1] ?? null
  };
}

const url = readArg('--url', process.env.QWT_ADDON_DATA_URL || DEFAULT_URL);
const outputPath = path.resolve(REPO_ROOT, readArg('--output', DEFAULT_OUTPUT));
const timeoutMs = Number(readArg('--timeout-ms', process.env.QWT_ADDON_DATA_TIMEOUT_MS || 45000));
const result = await downloadAddonData({ url, outputPath, timeoutMs });
console.log(JSON.stringify({ ok: true, source: url, ...result }, null, 2));
