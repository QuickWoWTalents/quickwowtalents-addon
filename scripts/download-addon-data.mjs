#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_URL = 'https://quickwowtalents.com/api/addon-data';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'QuickWoWTalentsData.lua');

function readArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

export function assertLooksLikeAddonLua(text) {
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

export function normalizeAddonDataForComparison(text) {
  return String(text)
    .replace(/^\s*generatedAt = "[^"]+",\s*$/m, '')
    .replace(/^\s*sourceGeneratedAt = "[^"]+",\s*$/m, '')
    .replace(/^\s*downloadedAt = "[^"]+",\s*$/m, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function addonDataHash(text) {
  return createHash('sha256').update(normalizeAddonDataForComparison(text)).digest('hex');
}

export async function downloadAddonData({ url, outputPath, timeoutMs }) {
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
  const normalizedText = text.endsWith('\n') ? text : `${text}\n`;
  let previousHash = null;

  try {
    previousHash = addonDataHash(await fs.readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const nextHash = addonDataHash(normalizedText);
  const changed = previousHash === null ? true : previousHash !== nextHash;

  if (changed) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, normalizedText, 'utf8');
  }

  return {
    outputPath,
    bytes: Buffer.byteLength(normalizedText),
    recommendations: Number(text.match(/counts = \{[\s\S]*?recommendations = (\d+)/)?.[1] ?? 0),
    generatedAt: text.match(/generatedAt = "([^"]+)"/)?.[1] ?? null,
    changed,
    previousHash,
    hash: nextHash
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = readArg('--url', process.env.QWT_ADDON_DATA_URL || DEFAULT_URL);
  const outputPath = path.resolve(REPO_ROOT, readArg('--output', DEFAULT_OUTPUT));
  const timeoutMs = Number(readArg('--timeout-ms', process.env.QWT_ADDON_DATA_TIMEOUT_MS || 45000));
  const result = await downloadAddonData({ url, outputPath, timeoutMs });
  console.log(JSON.stringify({ ok: true, source: url, ...result }, null, 2));
}
