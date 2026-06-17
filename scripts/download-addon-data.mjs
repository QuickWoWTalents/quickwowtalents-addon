#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_URL = 'https://quickwowtalents.com/api/addon-data';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'QuickWoWTalentsData.lua');
const DEFAULT_RETRY_DELAY_MS = 60_000;

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
  assertAddonDataCompleteness(text);
}

function extractBraceBlock(text, startIndex) {
  const firstBrace = text.indexOf('{', startIndex);
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, index + 1);
      }
    }
  }

  return null;
}

function extractNamedBlock(text, name) {
  const match = new RegExp(`\\b${name}\\s*=`).exec(text);
  if (!match) return null;
  return extractBraceBlock(text, match.index + match[0].length);
}

function extractNumberField(text, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

function countIdEntries(block) {
  return Array.from(String(block ?? '').matchAll(/\bid\s*=\s*\d+/g)).length;
}

function countValidImportStrings(text) {
  let count = 0;
  for (const match of String(text).matchAll(/\bimportString\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
    if (match[1].trim()) count += 1;
  }
  return count;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableDownloadError(error) {
  const status = Number(error?.status ?? 0);
  return error?.retriable === true
    || status === 408
    || status === 429
    || status >= 500
    || /ADDON_DATA_INCOMPLETE|temporarily|timeout|fetch failed/i.test(error?.message ?? '');
}

export function assertAddonDataCompleteness(text) {
  const countsBlock = extractNamedBlock(text, 'counts');
  if (!countsBlock) {
    throw new Error('Downloaded addon data does not include counts.');
  }

  const specs = extractNumberField(countsBlock, 'specs');
  const attempted = extractNumberField(countsBlock, 'attempted');
  const recommendations = extractNumberField(countsBlock, 'recommendations');
  const specsWithAnyRecommendation = extractNumberField(countsBlock, 'specsWithAnyRecommendation');
  const skipped = extractNumberField(countsBlock, 'skipped');

  for (const [name, value] of Object.entries({ specs, attempted, recommendations, specsWithAnyRecommendation, skipped })) {
    if (!Number.isInteger(value)) {
      throw new Error(`Downloaded addon data counts are missing ${name}.`);
    }
  }

  if (skipped !== 0 || recommendations !== attempted || specsWithAnyRecommendation !== specs) {
    throw new Error(`Addon data is incomplete: attempted=${attempted}, recommendations=${recommendations}, specs=${specs}, specsWithAnyRecommendation=${specsWithAnyRecommendation}, skipped=${skipped}.`);
  }

  const mplusBlock = extractNamedBlock(text, 'mplus');
  const raidBlock = extractNamedBlock(text, 'raid');
  const dungeonsBlock = extractNamedBlock(mplusBlock ?? '', 'dungeons');
  const bossesBlock = extractNamedBlock(raidBlock ?? '', 'bosses');
  const dungeons = countIdEntries(dungeonsBlock);
  const bosses = countIdEntries(bossesBlock);
  const expectedRecommendations = specs * (dungeons + bosses);

  if (expectedRecommendations !== recommendations) {
    throw new Error(`Addon data recommendation count does not match the expected matrix: expected=${expectedRecommendations}, recommendations=${recommendations}, specs=${specs}, dungeons=${dungeons}, bosses=${bosses}.`);
  }

  const minKeystoneLevel = extractNumberField(mplusBlock ?? '', 'minimumKeystoneLevel');
  if (minKeystoneLevel !== 15) {
    throw new Error(`Addon data Mythic+ Best Overall minimumKeystoneLevel must be 15, got ${minKeystoneLevel ?? 'missing'}.`);
  }

  const validImportStrings = countValidImportStrings(text);
  if (validImportStrings !== recommendations) {
    throw new Error(`Addon data is missing valid import strings: expected=${recommendations}, valid=${validImportStrings}.`);
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

async function fetchAddonDataText({ url, timeoutMs }) {
  const response = await fetch(url, {
    signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: {
      accept: 'text/plain',
      'user-agent': 'quickwowtalents-addon-release/0.2'
    }
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    error.status = response.status;
    error.retriable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }

  return text;
}

export async function downloadAddonData({ url, outputPath, timeoutMs, retries = 0, retryDelayMs = DEFAULT_RETRY_DELAY_MS }) {
  const maxRetries = Math.max(0, Number(retries) || 0);
  const normalizedRetryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
  let text = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      text = await fetchAddonDataText({ url, timeoutMs });
      break;
    } catch (error) {
      if (attempt >= maxRetries || !isRetriableDownloadError(error)) {
        throw error;
      }

      console.warn(`Addon data download attempt ${attempt + 1} failed; retrying in ${normalizedRetryDelayMs}ms: ${error.message}`);
      if (normalizedRetryDelayMs > 0) {
        await sleep(normalizedRetryDelayMs);
      }
    }
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
  const retries = Number(readArg('--retries', process.env.QWT_ADDON_DATA_RETRIES || 0));
  const retryDelayMs = Number(readArg('--retry-delay-ms', process.env.QWT_ADDON_DATA_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS));
  const result = await downloadAddonData({ url, outputPath, timeoutMs, retries, retryDelayMs });
  console.log(JSON.stringify({ ok: true, source: url, ...result }, null, 2));
}
