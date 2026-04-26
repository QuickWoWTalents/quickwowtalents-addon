#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'https://quickwowtalents.com';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'QuickWoWTalents', 'QuickWoWTalentsData.lua');
const SCHEMA_VERSION = 1;

const FALLBACK_SPEC_IDS = new Map([
  ['Death Knight:Blood', 250],
  ['Death Knight:Frost', 251],
  ['Death Knight:Unholy', 252],
  ['Demon Hunter:Havoc', 577],
  ['Demon Hunter:Vengeance', 581],
  ['Druid:Balance', 102],
  ['Druid:Feral', 103],
  ['Druid:Guardian', 104],
  ['Druid:Restoration', 105],
  ['Evoker:Devastation', 1467],
  ['Evoker:Preservation', 1468],
  ['Evoker:Augmentation', 1473],
  ['Hunter:Beast Mastery', 253],
  ['Hunter:Marksmanship', 254],
  ['Hunter:Survival', 255],
  ['Mage:Arcane', 62],
  ['Mage:Fire', 63],
  ['Mage:Frost', 64],
  ['Monk:Brewmaster', 268],
  ['Monk:Mistweaver', 270],
  ['Monk:Windwalker', 269],
  ['Paladin:Holy', 65],
  ['Paladin:Protection', 66],
  ['Paladin:Retribution', 70],
  ['Priest:Discipline', 256],
  ['Priest:Holy', 257],
  ['Priest:Shadow', 258],
  ['Rogue:Assassination', 259],
  ['Rogue:Outlaw', 260],
  ['Rogue:Subtlety', 261],
  ['Shaman:Elemental', 262],
  ['Shaman:Enhancement', 263],
  ['Shaman:Restoration', 264],
  ['Warlock:Affliction', 265],
  ['Warlock:Demonology', 266],
  ['Warlock:Destruction', 267],
  ['Warrior:Arms', 71],
  ['Warrior:Fury', 72],
  ['Warrior:Protection', 73]
]);

function readArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultMetric(spec) {
  return spec?.role === 'Healer' ? 'hps' : 'dps';
}

export function luaString(value) {
  return `"${String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}"`;
}

function isIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function luaKey(key) {
  if (/^(0|[1-9]\d*)$/.test(String(key))) {
    return `[${Number(key)}]`;
  }
  if (isIdentifier(String(key))) {
    return String(key);
  }
  return `[${luaString(key)}]`;
}

export function toLua(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const childPad = ' '.repeat(indent + 2);

  if (value == null) return 'nil';
  if (typeof value === 'string') return luaString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (Array.isArray(value)) {
    if (value.length === 0) return '{}';
    const lines = value.map((entry) => `${childPad}${toLua(entry, indent + 2)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }

  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) return '{}';

  const lines = entries.map(([key, entryValue]) => `${childPad}${luaKey(key)} = ${toLua(entryValue, indent + 2)}`);
  return `{\n${lines.join(',\n')}\n${pad}}`;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function fetchJson(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'quickwowtalents-addon-data-builder/0.1'
      }
    });

    if (response.ok) {
      return response.json();
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const text = await response.text().catch(() => '');
    const message = `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 240)}` : ''}`;

    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : 2500 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }

    throw new Error(message);
  }

  throw new Error(`Failed to fetch ${url}`);
}

function getDungeon(mythicPlus) {
  const defaultDungeonId = Number(mythicPlus?.defaultDungeonId);
  return (mythicPlus?.dungeons ?? []).find((entry) => Number(entry.id) === defaultDungeonId)
    ?? mythicPlus?.dungeons?.[0]
    ?? { id: defaultDungeonId || 0, name: 'Default dungeon' };
}

function getSpecJobs(options, onlySpec = null, limit = null) {
  const jobs = [];
  for (const classEntry of options.classes ?? []) {
    for (const spec of classEntry.specs ?? []) {
      const key = `${classEntry.className}:${spec.specName}`;
      if (onlySpec && key.toLowerCase() !== onlySpec.toLowerCase()) continue;
      jobs.push({
        key,
        className: classEntry.className,
        specName: spec.specName,
        role: spec.role,
        metric: getDefaultMetric(spec)
      });
    }
  }
  return Number.isFinite(limit) && limit > 0 ? jobs.slice(0, limit) : jobs;
}

function extractRecommendation({ job, buildPayload, dungeon, generatedAt }) {
  const mostCommon = buildPayload.summary?.mostCommon;
  const importString = mostCommon?.blizzardExportString;
  const specId = Number(mostCommon?.mzTalentTree?.specId ?? FALLBACK_SPEC_IDS.get(job.key));

  if (!importString || !Number.isFinite(specId)) {
    return null;
  }

  return {
    specId,
    entry: {
      mplusBestOverall: {
        mode: 'mplus',
        className: job.className,
        specName: job.specName,
        role: job.role,
        metric: job.metric,
        label: `${job.specName} ${job.className} — ${dungeon.name} Best Overall`,
        dungeonId: Number(dungeon.id),
        dungeonName: dungeon.name,
        keystoneLevel: 'overall',
        importString,
        sampleCount: Number(mostCommon.count ?? 0),
        adoptionRate: Number(mostCommon.adoptionRate ?? 0),
        averageAmount: Number(mostCommon.averageAmount ?? 0),
        bestAmount: Number(mostCommon.bestAmount ?? 0),
        apexTalent: mostCommon.apexTalent ?? undefined,
        totalLogs: Number(buildPayload.summary?.totalLogs ?? 0),
        distinctBuilds: Number(buildPayload.summary?.distinctBuilds ?? 0),
        selectionBasis: buildPayload.summary?.selectionBasis ?? 'unknown',
        snapshotDate: buildPayload.cache?.servedDayKey ?? buildPayload.cache?.dayKey ?? null,
        cacheCapturedAt: buildPayload.cache?.capturedAt ?? null,
        generatedAt
      }
    }
  };
}

export async function buildAddonData({
  baseUrl = DEFAULT_BASE_URL,
  generatedAt = new Date().toISOString(),
  delayMs = 1200,
  onlySpec = null,
  limit = null,
  onProgress = () => {}
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const options = await fetchJson(`${normalizedBaseUrl}/api/options`);
  const dungeon = getDungeon(options.mythicPlus);
  const jobs = getSpecJobs(options, onlySpec, limit);
  const recommendations = {};
  const skipped = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const params = new URLSearchParams({
      mode: 'mplus',
      region: options.defaultRegion ?? 'all',
      dungeonId: String(dungeon.id),
      keystoneLevel: 'overall',
      className: job.className,
      specName: job.specName,
      metric: job.metric
    });
    const url = `${normalizedBaseUrl}/api/build?${params}`;

    onProgress({ index: index + 1, total: jobs.length, job });

    try {
      const buildPayload = await fetchJson(url);
      const recommendation = extractRecommendation({ job, buildPayload, dungeon, generatedAt });
      if (recommendation) {
        recommendations[recommendation.specId] = recommendation.entry;
      } else {
        skipped.push({ key: job.key, reason: 'missing import string or spec id' });
      }
    } catch (error) {
      skipped.push({ key: job.key, reason: error?.message ?? String(error) });
    }

    if (delayMs > 0 && index < jobs.length - 1) {
      await sleep(delayMs);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    source: normalizedBaseUrl,
    generatedAt,
    mode: 'mplus',
    recommendationKind: 'default-dungeon-best-overall',
    dungeon: {
      id: Number(dungeon.id),
      name: dungeon.name
    },
    counts: {
      attempted: jobs.length,
      recommendations: Object.keys(recommendations).length,
      skipped: skipped.length
    },
    recommendations,
    skipped
  };
}

export function renderLuaData(payload) {
  return [
    '-- Generated by scripts/build-data.mjs. Do not edit by hand.',
    '-- Source of truth: Quick WoW Talents public cache/API.',
    `QuickWoWTalentsData = ${toLua(payload, 0)}`,
    ''
  ].join('\n');
}

export async function writeAddonData(outputPath = DEFAULT_OUTPUT, options = {}) {
  const payload = await buildAddonData(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderLuaData(payload), 'utf8');
  return { outputPath, payload };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = readArg('--base-url', process.env.QWT_BASE_URL || DEFAULT_BASE_URL);
  const outputPath = path.resolve(REPO_ROOT, readArg('--output', DEFAULT_OUTPUT));
  const delayMs = Number(readArg('--delay-ms', process.env.QWT_ADDON_DELAY_MS || 1200));
  const limitValue = readArg('--limit', null);
  const spec = readArg('--spec', null);
  const strict = hasFlag('--strict');
  const limit = limitValue == null ? null : Number(limitValue);

  const result = await writeAddonData(outputPath, {
    baseUrl,
    delayMs: Number.isFinite(delayMs) ? delayMs : 1200,
    onlySpec: spec,
    limit: Number.isFinite(limit) ? limit : null,
    onProgress({ index, total, job }) {
      console.error(`[${index}/${total}] ${job.className} ${job.specName} (${job.metric})`);
    }
  });

  console.log(JSON.stringify({
    ok: !strict || result.payload.skipped.length === 0,
    outputPath: result.outputPath,
    generatedAt: result.payload.generatedAt,
    dungeon: result.payload.dungeon,
    counts: result.payload.counts,
    skipped: result.payload.skipped
  }, null, 2));

  if (strict && result.payload.skipped.length > 0) {
    process.exitCode = 1;
  }
}
