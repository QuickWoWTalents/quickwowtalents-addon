#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { replaceFileAtomically } from './download-addon-data.mjs';
import { loadNormalizedCatalog, validateAddonContract } from './validate-addon-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'https://quickwowtalents.com';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'QuickWoWTalentsData.lua');
const SCHEMA_VERSION = 3;
const HEROIC_RAID_DIFFICULTY_ID = 4;
const MPLUS_BEST_OVERALL_MIN_KEYSTONE_LEVEL = 15;
const SAFE_SKIP_CODES = new Set(['NO_USABLE_LOGS', 'NO_COMPATIBLE_CURRENT_LOGS']);

function getMplusBestOverallLabel() {
  return `Best Overall (${MPLUS_BEST_OVERALL_MIN_KEYSTONE_LEVEL}+)`;
}

function readArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
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

async function fetchJson(url, { retries = 2, timeoutMs = Number(process.env.QWT_FETCH_TIMEOUT_MS || 30000) } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        headers: {
          accept: 'application/json',
          'user-agent': 'quickwowtalents-addon-data-builder/0.2'
        }
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      const message = timedOut
        ? `request timed out after ${timeoutMs}ms`
        : (error?.message ?? String(error));

      if (attempt < retries) {
        await sleep(2500 * (attempt + 1));
        continue;
      }

      throw new Error(`${url}: ${message}`);
    }

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

function getHeroicDifficulty(raid) {
  const difficulty = (raid?.difficulties ?? []).find((entry) => (
    Number(entry.id) === HEROIC_RAID_DIFFICULTY_ID && entry.name === 'Heroic'
  ));
  if (!difficulty) {
    throw new Error(`Resolved raid does not include exact Heroic difficulty ${HEROIC_RAID_DIFFICULTY_ID}.`);
  }
  return difficulty;
}

function normalizeEncounters(entries = []) {
  return entries.map((entry) => ({ id: Number(entry.id), name: entry.name })).filter((entry) => Number.isFinite(entry.id) && entry.name);
}

function normalizeRaidEncounters(entries = []) {
  return entries.map((entry) => {
    const encounter = {
      id: Number(entry.id),
      name: entry.name,
      encounterName: entry.encounterName ?? entry.name,
      raidName: entry.raidName,
      zoneId: Number(entry.zoneId)
    };
    if (Number.isFinite(encounter.id) && encounter.name && (
      !Number.isInteger(encounter.zoneId)
      || encounter.zoneId <= 0
      || !String(encounter.raidName ?? '').trim()
    )) {
      throw new Error(`Resolved raid boss ${encounter.id} has incomplete zone identity.`);
    }
    return encounter;
  }).filter((entry) => Number.isFinite(entry.id) && entry.name);
}

function ensureResolvedOptions(options) {
  if (options?.mythicPlus?.fallback === true) {
    throw new Error('Cannot build addon data from a fallback Mythic+ activity.');
  }
  if (options?.raid?.fallback === true) {
    throw new Error('Cannot build addon data from a fallback raid activity.');
  }
  if (!options?.talentCatalog || typeof options.talentCatalog !== 'object') {
    throw new Error('Resolved options do not include a talent catalog descriptor.');
  }
}

function clientInterfaceFromBuild(wowBuild) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.|$)/.exec(String(wowBuild ?? ''));
  if (!match) return null;
  return Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]);
}

function assertCatalogMatchesOptions(catalog, talentCatalog) {
  const descriptor = {
    source: catalog?.source,
    environment: catalog?.environment,
    generatedAt: catalog?.generatedAt,
    wowBuild: catalog?.wowBuild,
    contentHash: catalog?.contentHash,
    clientInterface: clientInterfaceFromBuild(catalog?.wowBuild),
    specCount: catalog?.specs && typeof catalog.specs === 'object'
      ? Object.keys(catalog.specs).length
      : 0
  };
  if (!isDeepStrictEqual(descriptor, talentCatalog)) {
    throw new Error('Normalized talent catalog descriptor does not match resolved options.');
  }
}

function createActivityDescriptor({ mythicPlus, raid, mplusDungeons, raidBosses, heroicDifficulty }) {
  const zones = [];
  const zonesById = new Map();
  for (const boss of raidBosses) {
    let zone = zonesById.get(boss.zoneId);
    if (!zone) {
      zone = { zoneId: boss.zoneId, name: boss.raidName, bossIds: [] };
      zonesById.set(boss.zoneId, zone);
      zones.push(zone);
    } else if (zone.name !== boss.raidName) {
      throw new Error(`Resolved raid zone ${boss.zoneId} has inconsistent names.`);
    }
    zone.bossIds.push(boss.id);
  }

  return {
    mythicPlus: {
      expansionId: Number(mythicPlus.expansionId),
      zoneId: Number(mythicPlus.zoneId),
      dungeonIds: mplusDungeons.map((dungeon) => dungeon.id)
    },
    raid: {
      expansionId: Number(raid.expansionId),
      primaryZoneId: Number(raid.zoneId),
      difficultyId: Number(heroicDifficulty.id),
      zones,
      bossIds: raidBosses.map((boss) => boss.id)
    }
  };
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

function createRecommendation({ job, buildPayload, generatedAt, mode, encounter, difficulty = null }) {
  const mostCommon = buildPayload.summary?.mostCommon;
  const importString = mostCommon?.blizzardExportString;
  const specId = Number(
    mostCommon?.talentTree?.specId
    ?? mostCommon?.mzTalentTree?.specId
  );

  if (!importString) throw new Error('Build payload does not include a Blizzard import string.');
  if (!Number.isInteger(specId) || specId <= 0) throw new Error('Build payload does not include a specialization ID.');

  const base = {
    mode,
    className: job.className,
    specName: job.specName,
    role: job.role,
    metric: job.metric,
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
  };

  if (mode === 'mplus') {
    return {
      specId,
      mode,
      encounterId: Number(encounter.id),
      entry: {
        ...base,
        label: `${job.specName} ${job.className} — ${encounter.name} ${getMplusBestOverallLabel()}`,
        dungeonId: Number(encounter.id),
        dungeonName: encounter.name,
        keystoneLevel: 'overall',
        minimumKeystoneLevel: MPLUS_BEST_OVERALL_MIN_KEYSTONE_LEVEL
      }
    };
  }

  return {
    specId,
    mode,
    encounterId: Number(encounter.id),
    entry: {
      ...base,
      label: `${job.specName} ${job.className} — ${difficulty.name} ${encounter.name}`,
      bossId: Number(encounter.id),
      bossName: encounter.name,
      difficultyId: Number(difficulty.id),
      difficultyName: difficulty.name
    }
  };
}

function createSkippedEntry(request, code, reason) {
  return {
    key: request.job.key,
    mode: request.mode,
    encounterId: request.encounter.id,
    encounterName: request.encounter.name,
    code,
    reason
  };
}

function getSafeGap(request, buildPayload) {
  const code = buildPayload?.empty?.reason;
  const confirmedEmpty = SAFE_SKIP_CODES.has(code)
    && buildPayload?.cache?.stale === false
    && buildPayload?.empty?.checkedWarcraftLogs === true
    && typeof buildPayload?.summary?.totalLogs === 'number'
    && Number.isFinite(buildPayload.summary.totalLogs)
    && buildPayload.summary.totalLogs === 0
    && !buildPayload?.summary?.mostCommon;
  if (!confirmedEmpty) return null;

  const reason = code === 'NO_COMPATIBLE_CURRENT_LOGS'
    ? 'Warcraft Logs runs were found, but all use talents outside the current talent catalog.'
    : 'No usable Warcraft Logs runs exist for this exact selection.';
  return createSkippedEntry(request, code, reason);
}

function assertBuildPayloadIdentity(buildPayload, talentCatalog) {
  if (!isDeepStrictEqual(buildPayload?.talentCatalog, talentCatalog)) {
    throw new Error('Per-build talent catalog descriptor mismatch.');
  }
}

function assertBuildSpecIdentity(buildPayload, catalog, job) {
  const expectedSpecId = catalog?.specs?.[job.key]?.specId;
  const actualSpecId = buildPayload?.summary?.mostCommon?.talentTree?.specId
    ?? buildPayload?.summary?.mostCommon?.mzTalentTree?.specId;
  if (!Number.isInteger(expectedSpecId) || Number(actualSpecId) !== expectedSpecId) {
    throw new Error(`Build payload specialization ${actualSpecId ?? 'missing'} does not match ${job.key} catalog specId ${expectedSpecId ?? 'missing'}.`);
  }
}

function ensureSpecEntry(recommendations, specId, job) {
  if (!recommendations[specId]) {
    recommendations[specId] = {
      className: job.className,
      specName: job.specName,
      role: job.role,
      mplus: { encounters: {} },
      raid: { encounters: {} }
    };
  }
  return recommendations[specId];
}

function createRequests({ options, jobs, mplusDungeons, raidBosses, heroicDifficulty }) {
  const requests = [];
  const region = options.defaultRegion ?? 'all';

  for (const job of jobs) {
    for (const dungeon of mplusDungeons) {
      requests.push({
        mode: 'mplus',
        job,
        encounter: dungeon,
        params: new URLSearchParams({
          mode: 'mplus',
          region,
          dungeonId: String(dungeon.id),
          keystoneLevel: 'overall',
          bestOverallMinKeystoneLevel: String(MPLUS_BEST_OVERALL_MIN_KEYSTONE_LEVEL),
          minKeystoneLevel: String(MPLUS_BEST_OVERALL_MIN_KEYSTONE_LEVEL),
          className: job.className,
          specName: job.specName,
          metric: job.metric
        })
      });
    }

    for (const boss of raidBosses) {
      requests.push({
        mode: 'raid',
        job,
        encounter: boss,
        difficulty: heroicDifficulty,
        params: new URLSearchParams({
          mode: 'raid',
          region,
          bossId: String(boss.id),
          difficulty: String(heroicDifficulty.id),
          exactSelection: 'true',
          className: job.className,
          specName: job.specName,
          metric: job.metric
        })
      });
    }
  }

  return requests;
}

async function buildAddonDataResult({
  baseUrl = DEFAULT_BASE_URL,
  generatedAt = new Date().toISOString(),
  delayMs = 1200,
  concurrency = 6,
  onlySpec = null,
  limit = null,
  onProgress = () => {},
  loadBuildPayload = null,
  catalog = null,
  catalogPath = null
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const resolvedCatalog = catalog ?? (catalogPath ? await loadNormalizedCatalog(catalogPath) : null);
  if (!resolvedCatalog) throw new Error('Local addon builder requires a normalized talent catalog.');
  const options = await fetchJson(`${normalizedBaseUrl}/api/options`);
  ensureResolvedOptions(options);
  assertCatalogMatchesOptions(resolvedCatalog, options.talentCatalog);
  const mplusDungeons = normalizeEncounters(options.mythicPlus?.dungeons ?? []);
  const raidBosses = normalizeRaidEncounters(options.raid?.bosses ?? []);
  const heroicDifficulty = getHeroicDifficulty(options.raid);
  const activities = createActivityDescriptor({
    mythicPlus: options.mythicPlus,
    raid: options.raid,
    mplusDungeons,
    raidBosses,
    heroicDifficulty
  });
  const jobs = getSpecJobs(options, onlySpec, limit);
  const requests = createRequests({ options, jobs, mplusDungeons, raidBosses, heroicDifficulty });
  const recommendations = {};
  const skippedByRequest = [];
  const errorsByRequest = [];
  let recommendationCount = 0;

  async function processRequest(index, request) {
    const url = `${normalizedBaseUrl}/api/build?${request.params}`;
    onProgress({ index: index + 1, total: requests.length, request });

    try {
      const buildPayload = loadBuildPayload
        ? await loadBuildPayload(request)
        : await fetchJson(url);
      assertBuildPayloadIdentity(buildPayload, options.talentCatalog);
      if (buildPayload?.cache?.stale !== false) {
        const code = buildPayload?.cache?.stale === true ? 'CACHE_STALE' : 'CACHE_INCOMPLETE';
        throw new Error(`Build payload lacks explicit fresh cache evidence (${code}) for ${request.job.key}.`);
      }
      if (request.mode === 'raid' && buildPayload.fallback) {
        throw new Error(`Unsafe addon data gap SELECTION_FALLBACK for ${request.job.key} raid ${request.encounter.id}.`);
      }
      const safeGap = getSafeGap(request, buildPayload);
      if (safeGap) {
        skippedByRequest[index] = safeGap;
        return;
      }
      if (!buildPayload?.summary?.mostCommon) {
        const code = buildPayload?.cache?.stale === true
          ? 'CACHE_STALE'
          : (buildPayload?.empty?.reason ?? 'BUILD_PAYLOAD_INCOMPLETE');
        throw new Error(`Unsafe addon data gap ${code} for ${request.job.key} ${request.mode} ${request.encounter.id}.`);
      }
      assertBuildSpecIdentity(buildPayload, resolvedCatalog, request.job);
      const recommendation = createRecommendation({
        job: request.job,
        buildPayload,
        generatedAt,
        mode: request.mode,
        encounter: request.encounter,
        difficulty: request.difficulty
      });

      const specEntry = ensureSpecEntry(recommendations, recommendation.specId, request.job);
      specEntry[recommendation.mode].encounters[recommendation.encounterId] = recommendation.entry;
      recommendationCount += 1;
    } catch (error) {
      errorsByRequest[index] = error;
    }
  }

  const maxConcurrency = Math.max(1, Number(concurrency) || 1);
  const inFlight = new Set();
  for (let index = 0; index < requests.length; index += 1) {
    while (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight);
    }

    const request = requests[index];
    const promise = processRequest(index, request).finally(() => {
      inFlight.delete(promise);
    });
    inFlight.add(promise);

    if (delayMs > 0 && index < requests.length - 1) {
      await sleep(delayMs);
    }
  }

  await Promise.all(inFlight);

  const firstError = errorsByRequest.find(Boolean);
  if (firstError) throw firstError;
  const skipped = skippedByRequest.filter(Boolean);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    source: normalizedBaseUrl,
    generatedAt,
    clientInterface: options.talentCatalog.clientInterface,
    talentCatalog: options.talentCatalog,
    activities,
    modes: {
      mplus: {
        label: 'Mythic+',
        recommendationKind: 'best-overall',
        keystoneLevel: 'overall',
        minimumKeystoneLevel: MPLUS_BEST_OVERALL_MIN_KEYSTONE_LEVEL,
        recommendationLabel: getMplusBestOverallLabel(),
        dungeons: mplusDungeons
      },
      raid: {
        label: 'Raid',
        recommendationKind: 'heroic-boss',
        difficulty: { id: Number(heroicDifficulty.id), name: heroicDifficulty.name },
        bosses: raidBosses
      }
    },
    counts: {
      specs: jobs.length,
      attempted: requests.length,
      emitted: recommendationCount,
      specsWithAnyRecommendation: Object.keys(recommendations).length,
      skipped: skipped.length
    },
    recommendations,
    skipped
  };
  return { payload, options, catalog: resolvedCatalog };
}

export async function buildAddonData(options = {}) {
  return (await buildAddonDataResult(options)).payload;
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
  const { payload, options: resolvedOptions, catalog } = await buildAddonDataResult(options);
  const addonText = renderLuaData(payload);
  validateAddonContract({ addonText, options: resolvedOptions, catalog });
  await replaceFileAtomically(outputPath, addonText);
  return { outputPath, payload };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = readArg('--base-url', process.env.QWT_BASE_URL || DEFAULT_BASE_URL);
  const outputPath = path.resolve(REPO_ROOT, readArg('--output', DEFAULT_OUTPUT));
  const delayMs = Number(readArg('--delay-ms', process.env.QWT_ADDON_DELAY_MS || 1200));
  const limitValue = readArg('--limit', null);
  const spec = readArg('--spec', null);
  const catalogArgument = readArg('--catalog', process.env.QWT_TALENT_CATALOG_PATH || null);
  const catalogPath = catalogArgument ? path.resolve(REPO_ROOT, catalogArgument) : null;
  const concurrencyValue = Number(readArg('--concurrency', process.env.QWT_ADDON_CONCURRENCY || 6));
  const limit = limitValue == null ? null : Number(limitValue);

  const result = await writeAddonData(outputPath, {
    baseUrl,
    delayMs: Number.isFinite(delayMs) ? delayMs : 1200,
    concurrency: Number.isFinite(concurrencyValue) ? concurrencyValue : 6,
    catalogPath,
    onlySpec: spec,
    limit: Number.isFinite(limit) ? limit : null,
    onProgress({ index, total, request }) {
      console.error(`[${index}/${total}] ${request.mode} ${request.encounter.name} — ${request.job.className} ${request.job.specName} (${request.job.metric})`);
    }
  });

  console.log(JSON.stringify({
    ok: true,
    outputPath: result.outputPath,
    generatedAt: result.payload.generatedAt,
    counts: result.payload.counts,
    modes: {
      mplusDungeons: result.payload.modes.mplus.dungeons.length,
      raidBosses: result.payload.modes.raid.bosses.length,
      raidDifficulty: result.payload.modes.raid.difficulty
    },
    skipped: result.payload.skipped
  }, null, 2));
}
