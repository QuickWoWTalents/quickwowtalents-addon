#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  loadVerifiedCatalogSnapshot,
  parseCatalogDownloadDescriptor,
  parseVerifiedCatalogArchive,
} from './catalog-download-contract.mjs';
import { getParsedLuaKeyKind, parseAddonLua } from './parse-addon-lua.mjs';
import { loadVerifiedReleaseInputSnapshot } from './release-input-snapshot.mjs';

const gunzipAsync = promisify(gunzip);
const EXPECTED_SCHEMA_VERSION = 3;
const EXPECTED_CLIENT_INTERFACE = 120100;
const EXPECTED_SPEC_COUNT = 40;
const EXPECTED_HEROIC_DIFFICULTY_ID = 4;
const EXPECTED_EXPORT_VERSION = 2;
const BLIZZARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SAFE_SKIP_CODES = new Set(['NO_USABLE_LOGS', 'NO_COMPATIBLE_CURRENT_LOGS']);
const CATALOG_FIELDS = [
  'source',
  'environment',
  'generatedAt',
  'wowBuild',
  'contentHash',
  'clientInterface',
  'specCount'
];
const COUNT_FIELDS = ['specs', 'attempted', 'emitted', 'specsWithAnyRecommendation', 'skipped'];

class AddonContractError extends Error {
  constructor(message) {
    super(`Addon contract validation failed: ${message}`);
    this.name = 'AddonContractError';
  }
}

function fail(message) {
  throw new AddonContractError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be a keyed table.`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an ordered array.`);
  return value;
}

function keyedEntries(value, label) {
  if (Array.isArray(value) && value.length === 0) return [];
  return Object.entries(requireRecord(value, label));
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value;
}

function requireInteger(value, label, { positive = false } = {}) {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0)) {
    fail(`${label} must be a ${positive ? 'positive' : 'non-negative'} integer.`);
  }
  return value;
}

function requireExactFields(record, fields, label) {
  const actual = Object.keys(requireRecord(record, label)).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${label} must contain exactly the ${fields.length} descriptor fields: ${fields.join(', ')}.`);
  }
}

function requireDescriptor(value, label) {
  const descriptor = requireRecord(value, label);
  requireExactFields(descriptor, CATALOG_FIELDS, label);
  for (const field of ['source', 'environment', 'generatedAt', 'wowBuild', 'contentHash']) {
    requireString(descriptor[field], `${label}.${field}`);
  }
  requireInteger(descriptor.clientInterface, `${label}.clientInterface`, { positive: true });
  requireInteger(descriptor.specCount, `${label}.specCount`, { positive: true });
  return descriptor;
}

function requireSameDescriptor(actual, expected, label) {
  for (const field of CATALOG_FIELDS) {
    if (actual[field] !== expected[field]) {
      fail(`${label} catalog descriptor disagrees for ${field}.`);
    }
  }
}

function clientInterfaceFromBuild(wowBuild) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.|$)/.exec(wowBuild);
  if (!match) return null;
  return Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]);
}

function inspectCatalog(catalog) {
  const root = requireRecord(catalog, 'normalized talent catalog');
  if (root.source !== 'raidbots') fail('normalized talent catalog must use the canonical Raidbots source.');
  if (root.environment !== 'live') fail('normalized talent catalog must use the live environment.');
  const generatedAt = requireString(root.generatedAt, 'normalized talent catalog.generatedAt');
  const wowBuild = requireString(root.wowBuild, 'normalized talent catalog.wowBuild');
  if (!/^12\.1\./.test(wowBuild)) fail('normalized talent catalog must describe a WoW 12.1.x build.');
  const clientInterface = clientInterfaceFromBuild(wowBuild);
  if (clientInterface !== EXPECTED_CLIENT_INTERFACE) {
    fail(`normalized talent catalog must derive client interface ${EXPECTED_CLIENT_INTERFACE}.`);
  }
  const contentHash = requireString(root.contentHash, 'normalized talent catalog.contentHash');
  const specEntries = keyedEntries(root.specs, 'normalized talent catalog.specs');
  if (specEntries.length !== EXPECTED_SPEC_COUNT) {
    fail(`normalized talent catalog must contain exactly ${EXPECTED_SPEC_COUNT} specs.`);
  }

  const specById = new Map();
  const specByKey = new Map();
  for (const [key, rawSpec] of specEntries) {
    const spec = requireRecord(rawSpec, `normalized talent catalog spec ${key}`);
    const specId = requireInteger(spec.specId, `normalized talent catalog spec ${key}.specId`, { positive: true });
    const className = requireString(spec.className, `normalized talent catalog spec ${key}.className`);
    const specName = requireString(spec.specName, `normalized talent catalog spec ${key}.specName`);
    if (`${className}:${specName}` !== key) {
      fail(`normalized talent catalog spec key ${key} disagrees with its class and spec names.`);
    }
    if (specById.has(specId)) {
      fail(`normalized talent catalog maps specId ${specId} more than once.`);
    }
    specById.set(specId, spec);
    specByKey.set(key, spec);
  }

  return {
    descriptor: {
      source: root.source,
      environment: root.environment,
      generatedAt,
      wowBuild,
      contentHash,
      clientInterface,
      specCount: specEntries.length
    },
    specById,
    specByKey
  };
}

function inspectOptionsCatalog(options, catalog) {
  const catalogInfo = inspectCatalog(catalog);
  const optionsRoot = requireRecord(options, 'options');
  const optionsDescriptor = requireDescriptor(optionsRoot.talentCatalog, 'options talentCatalog');
  requireSameDescriptor(optionsDescriptor, catalogInfo.descriptor, 'options and normalized catalog');
  if (optionsDescriptor.source !== 'raidbots' || optionsDescriptor.environment !== 'live') {
    fail('options talentCatalog must describe the canonical Raidbots live catalog.');
  }
  if (!/^12\.1\./.test(optionsDescriptor.wowBuild)) {
    fail('options talentCatalog must describe a WoW 12.1.x build.');
  }
  if (optionsDescriptor.clientInterface !== EXPECTED_CLIENT_INTERFACE
    || optionsDescriptor.specCount !== EXPECTED_SPEC_COUNT) {
    fail(`options talentCatalog must use interface ${EXPECTED_CLIENT_INTERFACE} and ${EXPECTED_SPEC_COUNT} specs.`);
  }
  return { catalogInfo, optionsDescriptor, optionsRoot };
}

export function validateOptionsCatalog({ options, catalog } = {}) {
  const { catalogInfo } = inspectOptionsCatalog(options, catalog);
  return { catalogHash: catalogInfo.descriptor.contentHash };
}

function requireUniquePositiveIds(entries, label) {
  const ids = entries.map((entry, index) => {
    const record = requireRecord(entry, `${label}[${index}]`);
    return requireInteger(record.id, `${label}[${index}].id`, { positive: true });
  });
  if (new Set(ids).size !== ids.length) fail(`${label} contains duplicate IDs.`);
  return ids;
}

function buildOptionsActivityIdentity(options) {
  const root = requireRecord(options, 'options');
  const mythicPlus = requireRecord(root.mythicPlus, 'options.mythicPlus');
  const dungeons = requireArray(mythicPlus.dungeons, 'options.mythicPlus.dungeons');
  if (dungeons.length === 0) fail('options.mythicPlus.dungeons must not be empty.');
  const dungeonIds = requireUniquePositiveIds(dungeons, 'options.mythicPlus.dungeons');
  dungeons.forEach((dungeon, index) => {
    requireString(dungeon.name, `options.mythicPlus.dungeons[${index}].name`);
  });

  const raid = requireRecord(root.raid, 'options.raid');
  const bosses = requireArray(raid.bosses, 'options.raid.bosses');
  if (bosses.length === 0) fail('options.raid.bosses must not be empty.');
  const bossIds = requireUniquePositiveIds(bosses, 'options.raid.bosses');
  const zones = [];
  const zonesById = new Map();
  bosses.forEach((boss, index) => {
    requireString(boss.name, `options.raid.bosses[${index}].name`);
    const zoneId = requireInteger(boss.zoneId, `options.raid.bosses[${index}].zoneId`, { positive: true });
    const raidName = requireString(boss.raidName, `options.raid.bosses[${index}].raidName`);
    let zone = zonesById.get(zoneId);
    if (!zone) {
      zone = { zoneId, name: raidName, bossIds: [] };
      zonesById.set(zoneId, zone);
      zones.push(zone);
    } else if (zone.name !== raidName) {
      fail(`options raid zone ${zoneId} has inconsistent names.`);
    }
    zone.bossIds.push(bossIds[index]);
  });

  const difficulties = requireArray(raid.difficulties, 'options.raid.difficulties');
  const heroicMatches = difficulties.filter((difficulty) => (
    isRecord(difficulty)
    && difficulty.id === EXPECTED_HEROIC_DIFFICULTY_ID
    && difficulty.name === 'Heroic'
  ));
  if (heroicMatches.length !== 1) {
    fail(`options must contain exactly one Heroic raid difficulty ${EXPECTED_HEROIC_DIFFICULTY_ID}.`);
  }

  const primaryZoneId = requireInteger(raid.zoneId, 'options.raid.zoneId', { positive: true });
  if (!zonesById.has(primaryZoneId)) fail('options raid primary zone is absent from its ordered zones.');

  return {
    mythicPlus: {
      expansionId: requireInteger(mythicPlus.expansionId, 'options.mythicPlus.expansionId', { positive: true }),
      zoneId: requireInteger(mythicPlus.zoneId, 'options.mythicPlus.zoneId', { positive: true }),
      dungeonIds
    },
    raid: {
      expansionId: requireInteger(raid.expansionId, 'options.raid.expansionId', { positive: true }),
      primaryZoneId,
      difficultyId: EXPECTED_HEROIC_DIFFICULTY_ID,
      zones,
      bossIds
    }
  };
}

function sameOrderedValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function requirePositiveIntegerArray(value, label) {
  const entries = requireArray(value, label);
  const ids = entries.map((entry, index) => requireInteger(entry, `${label}[${index}]`, { positive: true }));
  if (new Set(ids).size !== ids.length) fail(`${label} contains duplicate IDs.`);
  return ids;
}

function validateActivityIdentity(value, expected) {
  const activities = requireRecord(value, 'artifact activities');
  const mythicPlus = requireRecord(activities.mythicPlus, 'artifact activities.mythicPlus');
  const dungeonIds = requirePositiveIntegerArray(
    mythicPlus.dungeonIds,
    'artifact activities.mythicPlus.dungeonIds'
  );
  if (mythicPlus.expansionId !== expected.mythicPlus.expansionId
    || mythicPlus.zoneId !== expected.mythicPlus.zoneId
    || !sameOrderedValues(dungeonIds, expected.mythicPlus.dungeonIds)) {
    fail('artifact Mythic+ activity identity and dungeon order disagree with options.');
  }

  const raid = requireRecord(activities.raid, 'artifact activities.raid');
  const bossIds = requirePositiveIntegerArray(raid.bossIds, 'artifact activities.raid.bossIds');
  const zones = requireArray(raid.zones, 'artifact activities.raid.zones').map((rawZone, index) => {
    const zone = requireRecord(rawZone, `artifact activities.raid.zones[${index}]`);
    return {
      zoneId: requireInteger(zone.zoneId, `artifact activities.raid.zones[${index}].zoneId`, { positive: true }),
      name: requireString(zone.name, `artifact activities.raid.zones[${index}].name`),
      bossIds: requirePositiveIntegerArray(
        zone.bossIds,
        `artifact activities.raid.zones[${index}].bossIds`
      )
    };
  });
  const zonesMatch = zones.length === expected.raid.zones.length && zones.every((zone, index) => (
    zone.zoneId === expected.raid.zones[index].zoneId
    && zone.name === expected.raid.zones[index].name
    && sameOrderedValues(zone.bossIds, expected.raid.zones[index].bossIds)
  ));
  if (raid.expansionId !== expected.raid.expansionId
    || raid.primaryZoneId !== expected.raid.primaryZoneId
    || raid.difficultyId !== expected.raid.difficultyId
    || !sameOrderedValues(bossIds, expected.raid.bossIds)
    || !zonesMatch
    || !sameOrderedValues(zones.flatMap((zone) => zone.bossIds), bossIds)) {
    fail('artifact raid activity identity, difficulty, zones, or boss order disagrees with options.');
  }

  return { dungeonIds, bossIds, difficultyId: expected.raid.difficultyId };
}

class BlizzardBitReader {
  constructor(importString) {
    this.values = [...importString].map((character) => BLIZZARD_BASE64.indexOf(character));
    this.bitOffset = 0;
  }

  get bitLength() {
    return this.values.length * 6;
  }

  read(width, label) {
    if (this.bitOffset + width > this.bitLength) {
      fail(`Blizzard import string is truncated while reading ${label}.`);
    }
    let value = 0;
    for (let bit = 0; bit < width; bit += 1) {
      const absoluteBit = this.bitOffset + bit;
      const characterValue = this.values[Math.floor(absoluteBit / 6)];
      const bitValue = Math.floor(characterValue / (2 ** (absoluteBit % 6))) % 2;
      value += bitValue * (2 ** bit);
    }
    this.bitOffset += width;
    return value;
  }

  finish() {
    const remaining = this.bitLength - this.bitOffset;
    if (remaining >= 6) fail('Blizzard import string contains trailing base64 characters.');
    for (let offset = this.bitOffset; offset < this.bitLength; offset += 1) {
      const value = this.values[Math.floor(offset / 6)];
      if (Math.floor(value / (2 ** (offset % 6))) % 2 !== 0) {
        fail('Blizzard import string contains non-zero padding bits.');
      }
    }
  }
}

function isChoiceNode(node) {
  const type = String(node?.type ?? '').toLowerCase();
  return type === 'choice' || type === 'selection' || type === 'subtree' || type === 'subtreeselection';
}

function requireSelectedNode(specRecord, nodeId) {
  const node = specRecord.nodes?.[String(nodeId)];
  if (!isRecord(node) || Number(node.id) !== nodeId) {
    fail(`Blizzard import string selects unknown node ${nodeId}.`);
  }
  const maxRanks = Number(node.maxRanks ?? 1);
  if (!Number.isInteger(maxRanks) || maxRanks <= 0 || maxRanks > 63) {
    fail(`catalog node ${nodeId} has invalid maxRanks ${node.maxRanks}.`);
  }
  if (!Array.isArray(node.entries) || node.entries.length === 0) {
    fail(`catalog node ${nodeId} has no known talent entries.`);
  }
  return { node, maxRanks };
}

function requireKnownTalent(specRecord, node, nodeId, entryIndex) {
  const entry = node.entries[entryIndex];
  const talentId = Number(entry?.id);
  if (!Number.isInteger(talentId) || talentId <= 0) {
    fail(`catalog node ${nodeId} has an invalid talent entry at index ${entryIndex}.`);
  }
  const talent = specRecord.talents?.[String(talentId)];
  if (!isRecord(talent) || Number(talent.nodeId) !== nodeId) {
    fail(`Blizzard import string resolves to unknown talent ${talentId} on node ${nodeId}.`);
  }
  return entry;
}

/**
 * Validates a Blizzard loadout string structurally against one normalized spec.
 */
export function validateImportStringForSpec(importString, specRecord) {
  if (typeof importString !== 'string' || importString.length === 0) {
    fail('Blizzard import string must be non-empty.');
  }
  if (!/^[A-Za-z0-9+/]+$/.test(importString)) {
    fail('Blizzard import string contains characters outside the Blizzard base64 alphabet.');
  }
  const spec = requireRecord(specRecord, 'catalog specialization record');
  const expectedSpecId = requireInteger(spec.specId, 'catalog specialization specId', { positive: true });
  const nodeOrder = requireArray(spec.fullNodeOrder, `catalog specialization ${expectedSpecId}.fullNodeOrder`);
  if (nodeOrder.length === 0) fail(`catalog specialization ${expectedSpecId}.fullNodeOrder must not be empty.`);

  const normalizedNodeOrder = nodeOrder.map((rawNodeId, index) => (
    requireInteger(Number(rawNodeId), `catalog specialization ${expectedSpecId}.fullNodeOrder[${index}]`, { positive: true })
  ));
  if (new Set(normalizedNodeOrder).size !== normalizedNodeOrder.length) {
    fail(`catalog specialization ${expectedSpecId}.fullNodeOrder contains duplicate nodes.`);
  }
  requireRecord(spec.nodes, `catalog specialization ${expectedSpecId}.nodes`);
  requireRecord(spec.talents, `catalog specialization ${expectedSpecId}.talents`);

  const reader = new BlizzardBitReader(importString);
  const version = reader.read(8, 'the export version');
  if (version !== EXPECTED_EXPORT_VERSION) {
    fail(`Blizzard import string must use export version ${EXPECTED_EXPORT_VERSION}, got ${version}.`);
  }
  const actualSpecId = reader.read(16, 'the specialization ID');
  if (actualSpecId !== expectedSpecId) {
    fail(`Blizzard import string specId ${actualSpecId} does not match catalog specId ${expectedSpecId}.`);
  }
  for (let byte = 0; byte < 16; byte += 1) {
    if (reader.read(8, `tree hash byte ${byte + 1}`) !== 0) {
      fail('Blizzard import string tree hash header must be all zeroes.');
    }
  }

  for (const nodeId of normalizedNodeOrder) {
    const selected = reader.read(1, `node ${nodeId} selected bit`) === 1;
    if (!selected) continue;

    const { node, maxRanks } = requireSelectedNode(spec, nodeId);
    const purchased = reader.read(1, `node ${nodeId} purchased bit`) === 1;
    if (!purchased) {
      if (node.freeNode !== true) {
        fail(`Blizzard import string marks non-free node ${nodeId} as granted.`);
      }
      requireKnownTalent(spec, node, nodeId, 0);
      continue;
    }
    if (node.freeNode === true) {
      fail(`Blizzard import string marks free node ${nodeId} as purchased.`);
    }

    const partial = reader.read(1, `node ${nodeId} partial-rank bit`) === 1;
    const ranks = partial ? reader.read(6, `node ${nodeId} partial rank`) : maxRanks;
    if (partial && (ranks <= 0 || ranks >= maxRanks)) {
      fail(`Blizzard import string has invalid partial rank ${ranks} for node ${nodeId} with maxRanks ${maxRanks}.`);
    }

    const encodedChoice = reader.read(1, `node ${nodeId} choice bit`) === 1;
    const expectedChoice = isChoiceNode(node);
    if (encodedChoice !== expectedChoice) {
      fail(`Blizzard import string choice flag is incompatible with catalog node ${nodeId}.`);
    }
    if (encodedChoice) {
      const choiceIndex = reader.read(2, `node ${nodeId} choice index`);
      if (choiceIndex >= node.entries.length) {
        fail(`Blizzard import string choice index ${choiceIndex} is outside node ${nodeId} entries.`);
      }
      const entry = requireKnownTalent(spec, node, nodeId, choiceIndex);
      const entryMaxRanks = Number(entry.maxRanks ?? maxRanks);
      if (!Number.isInteger(entryMaxRanks) || entryMaxRanks <= 0 || ranks > entryMaxRanks) {
        fail(`Blizzard import string rank ${ranks} exceeds choice talent bounds on node ${nodeId}.`);
      }
    } else {
      for (let index = 0; index < node.entries.length; index += 1) {
        requireKnownTalent(spec, node, nodeId, index);
      }
      if (node.entries.length === 1) {
        const entryMaxRanks = Number(node.entries[0].maxRanks ?? maxRanks);
        if (!Number.isInteger(entryMaxRanks) || entryMaxRanks <= 0 || ranks > entryMaxRanks) {
          fail(`Blizzard import string rank ${ranks} exceeds talent bounds on node ${nodeId}.`);
        }
      }
    }
  }

  reader.finish();
  return true;
}

function recommendationCoordinate(specId, mode, encounterId) {
  return `${specId}:${mode}:${encounterId}`;
}

function addCoordinate(coordinates, coordinate) {
  if (coordinates.has(coordinate)) fail(`artifact contains duplicate matrix coordinate ${coordinate}.`);
  coordinates.add(coordinate);
}

function inspectRecommendations(value, activityIdentity, catalogInfo, coordinates) {
  let emitted = 0;
  const specsWithRecommendations = new Set();
  for (const [rawSpecId, rawSpecTable] of keyedEntries(value, 'artifact recommendations')) {
    if (getParsedLuaKeyKind(value, rawSpecId) !== 'number') {
      fail(`artifact recommendation specialization ${rawSpecId} must use an explicit numeric Lua key.`);
    }
    if (!/^[1-9]\d*$/.test(rawSpecId)) {
      fail(`artifact recommendation specialization key ${JSON.stringify(rawSpecId)} must be a positive integer.`);
    }
    const specId = Number(rawSpecId);
    const specRecord = catalogInfo.specById.get(specId);
    if (!specRecord) fail(`artifact recommendation specialization ${specId} maps to no catalog specId ${specId}.`);
    const specTable = requireRecord(rawSpecTable, `artifact recommendation specialization ${specId}`);
    if (specTable.className !== specRecord.className || specTable.specName !== specRecord.specName) {
      fail(`artifact recommendation specialization ${specId} className/specName does not match the catalog record.`);
    }
    let specEmitted = 0;

    for (const mode of ['mplus', 'raid']) {
      const modeTable = requireRecord(specTable[mode], `artifact recommendation specialization ${specId}.${mode}`);
      const allowedIds = mode === 'mplus' ? activityIdentity.dungeonIds : activityIdentity.bossIds;
      const allowedIdSet = new Set(allowedIds);
      const encounters = modeTable.encounters;
      for (const [rawEncounterId, rawRecommendation] of keyedEntries(
        encounters,
        `artifact recommendation specialization ${specId}.${mode}.encounters`
      )) {
        if (getParsedLuaKeyKind(encounters, rawEncounterId) !== 'number') {
          fail(`${mode} recommendation encounter ${rawEncounterId} must use an explicit numeric Lua key.`);
        }
        if (!/^[1-9]\d*$/.test(rawEncounterId)) {
          fail(`${mode} recommendation encounter key must be a positive integer.`);
        }
        const encounterId = Number(rawEncounterId);
        if (!allowedIdSet.has(encounterId)) {
          fail(`${mode} recommendation encounter ${encounterId} is outside the declared activity matrix.`);
        }
        const recommendation = requireRecord(
          rawRecommendation,
          `artifact recommendation ${specId}:${mode}:${encounterId}`
        );
        if (recommendation.className !== specRecord.className
          || recommendation.specName !== specRecord.specName) {
          fail(`artifact recommendation ${specId}:${mode}:${encounterId} className/specName does not match the catalog record.`);
        }
        const identityField = mode === 'mplus' ? 'dungeonId' : 'bossId';
        if (recommendation[identityField] !== encounterId) {
          fail(`${mode} recommendation ${specId}:${encounterId} disagrees with its ${identityField}.`);
        }
        if (mode === 'raid' && recommendation.difficultyId !== activityIdentity.difficultyId) {
          fail(`raid recommendation ${specId}:${encounterId} disagrees with difficultyId.`);
        }
        if (typeof recommendation.importString !== 'string' || !recommendation.importString.trim()) {
          fail(`${mode} recommendation ${specId}:${encounterId} import string must be non-empty.`);
        }
        try {
          validateImportStringForSpec(recommendation.importString, specRecord);
        } catch (error) {
          if (error instanceof AddonContractError) {
            fail(`${mode} recommendation ${specId}:${encounterId} is incompatible: ${error.message.replace(/^Addon contract validation failed: /, '')}`);
          }
          throw error;
        }
        addCoordinate(coordinates, recommendationCoordinate(specId, mode, encounterId));
        emitted += 1;
        specEmitted += 1;
      }
    }
    if (specEmitted === 0) {
      fail(`artifact recommendation specialization ${specId} has no emitted recommendations.`);
    }
    specsWithRecommendations.add(specId);
  }
  return { emitted, specsWithAnyRecommendation: specsWithRecommendations.size };
}

function inspectSkipped(value, activityIdentity, catalogInfo, coordinates) {
  const skipped = requireArray(value, 'artifact skipped');
  const dungeonIds = new Set(activityIdentity.dungeonIds);
  const bossIds = new Set(activityIdentity.bossIds);
  skipped.forEach((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `artifact skipped[${index}]`);
    const code = requireString(entry.code, `artifact skipped[${index}].code`);
    if (!SAFE_SKIP_CODES.has(code)) fail(`artifact contains unknown skip code ${code}.`);
    const key = requireString(entry.key, `artifact skipped[${index}].key`);
    const specRecord = catalogInfo.specByKey.get(key);
    if (!specRecord) fail(`artifact skipped[${index}] references unknown catalog spec key ${key}.`);
    if (entry.mode !== 'mplus' && entry.mode !== 'raid') {
      fail(`artifact skipped[${index}].mode must be mplus or raid.`);
    }
    const encounterId = requireInteger(
      entry.encounterId,
      `artifact skipped[${index}].encounterId`,
      { positive: true }
    );
    const allowedIds = entry.mode === 'mplus' ? dungeonIds : bossIds;
    if (!allowedIds.has(encounterId)) {
      fail(`artifact skipped[${index}] encounter ${encounterId} is outside the declared activity matrix.`);
    }
    addCoordinate(
      coordinates,
      recommendationCoordinate(Number(specRecord.specId), entry.mode, encounterId)
    );
  });
  return skipped.length;
}

function requireCounts(value) {
  const counts = requireRecord(value, 'artifact counts');
  requireExactFields(counts, COUNT_FIELDS, 'artifact counts');
  for (const field of COUNT_FIELDS) requireInteger(counts[field], `artifact counts.${field}`);
  return counts;
}

/**
 * Validates parsed schema, options identity, catalog identity, matrix coverage,
 * safe gaps, and every emitted Blizzard loadout.
 */
export function validateAddonContract({ addonText, options, catalog } = {}) {
  let data;
  try {
    data = parseAddonLua(addonText);
  } catch (error) {
    fail(`addon Lua could not be parsed safely: ${error.message ?? String(error)}`);
  }
  const root = requireRecord(data, 'artifact root');
  if (root.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    fail(`artifact must use schema ${EXPECTED_SCHEMA_VERSION}.`);
  }
  requireString(root.generatedAt, 'artifact generatedAt');
  if (root.clientInterface !== EXPECTED_CLIENT_INTERFACE) {
    fail(`artifact must use client interface ${EXPECTED_CLIENT_INTERFACE}.`);
  }

  const { catalogInfo, optionsDescriptor, optionsRoot } = inspectOptionsCatalog(options, catalog);
  const artifactDescriptor = requireDescriptor(root.talentCatalog, 'artifact talentCatalog');
  requireSameDescriptor(artifactDescriptor, optionsDescriptor, 'artifact and options');

  const expectedActivities = buildOptionsActivityIdentity(optionsRoot);
  const activityIdentity = validateActivityIdentity(root.activities, expectedActivities);
  const counts = requireCounts(root.counts);
  const activityCount = activityIdentity.dungeonIds.length + activityIdentity.bossIds.length;
  const expectedAttempted = EXPECTED_SPEC_COUNT * activityCount;
  if (counts.specs !== EXPECTED_SPEC_COUNT) {
    fail(`artifact counts.specs must equal ${EXPECTED_SPEC_COUNT}.`);
  }
  if (counts.attempted !== expectedAttempted) {
    fail(`artifact counts.attempted must equal counts.specs times the activity count (${expectedAttempted}).`);
  }
  if (counts.emitted + counts.skipped !== counts.attempted) {
    fail('artifact counts.emitted + counts.skipped must equal counts.attempted.');
  }

  const coordinates = new Set();
  const recommendationCounts = inspectRecommendations(
    root.recommendations,
    activityIdentity,
    catalogInfo,
    coordinates
  );
  const actualSkipped = inspectSkipped(root.skipped, activityIdentity, catalogInfo, coordinates);
  if (recommendationCounts.emitted !== counts.emitted) {
    fail(`artifact counts.emitted is ${counts.emitted}, but ${recommendationCounts.emitted} recommendations exist.`);
  }
  if (recommendationCounts.specsWithAnyRecommendation !== counts.specsWithAnyRecommendation) {
    fail(`artifact counts.specsWithAnyRecommendation is ${counts.specsWithAnyRecommendation}, but ${recommendationCounts.specsWithAnyRecommendation} specs have recommendations.`);
  }
  if (actualSkipped !== counts.skipped) {
    fail(`artifact counts.skipped is ${counts.skipped}, but ${actualSkipped} skipped entries exist.`);
  }
  if (coordinates.size !== expectedAttempted) {
    fail(`artifact matrix cardinality is ${coordinates.size}, expected ${expectedAttempted}.`);
  }
  for (const specId of catalogInfo.specById.keys()) {
    for (const dungeonId of activityIdentity.dungeonIds) {
      const coordinate = recommendationCoordinate(specId, 'mplus', dungeonId);
      if (!coordinates.has(coordinate)) fail(`artifact matrix is missing coordinate ${coordinate}.`);
    }
    for (const bossId of activityIdentity.bossIds) {
      const coordinate = recommendationCoordinate(specId, 'raid', bossId);
      if (!coordinates.has(coordinate)) fail(`artifact matrix is missing coordinate ${coordinate}.`);
    }
  }

  return {
    data,
    catalogHash: catalogInfo.descriptor.contentHash,
    emitted: counts.emitted,
    skipped: counts.skipped
  };
}

/** Loads a normalized catalog from uncompressed JSON or gzip-compressed JSON. */
async function parseNormalizedCatalogBytes(filePath, inputBytes) {
  if (typeof filePath !== 'string' || !filePath) fail('catalog path must be a non-empty string.');
  let bytes = Buffer.from(inputBytes);
  try {
    if (filePath.endsWith('.json.gz')) {
      bytes = await gunzipAsync(bytes);
    } else if (!filePath.endsWith('.json')) {
      fail('catalog path must end in .json or .json.gz.');
    }
    const catalog = JSON.parse(bytes.toString('utf8'));
    return requireRecord(catalog, 'normalized talent catalog');
  } catch (error) {
    if (error instanceof AddonContractError) throw error;
    fail(`could not load normalized talent catalog ${filePath}: ${error.message ?? String(error)}`);
  }
}

export async function loadNormalizedCatalog(filePath) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    fail(`could not load normalized talent catalog ${filePath}: ${error.message ?? String(error)}`);
  }
  return parseNormalizedCatalogBytes(filePath, bytes);
}

export async function loadCatalogForOptions(filePath, options, {
  requireDownloadIdentity = false,
  catalogBytes = null,
  ...limits
} = {}) {
  if (requireDownloadIdentity) {
    try {
      if (catalogBytes !== null) {
        const descriptor = parseCatalogDownloadDescriptor(options, limits);
        return await parseVerifiedCatalogArchive(catalogBytes, descriptor, limits);
      }
      return await loadVerifiedCatalogSnapshot(filePath, options, limits);
    } catch (error) {
      fail(error.message ?? 'persisted catalog snapshot validation failed.');
    }
  }
  if (catalogBytes !== null) return parseNormalizedCatalogBytes(filePath, catalogBytes);
  return loadNormalizedCatalog(filePath);
}

function readCliArgument(flag) {
  const indexes = process.argv
    .map((argument, index) => (argument === flag ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length !== 1) fail(`CLI requires exactly one ${flag} argument.`);
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) fail(`CLI requires a value for ${flag}.`);
  return value;
}

function readCliBooleanFlag(flag) {
  const count = process.argv.filter((argument) => argument === flag).length;
  if (count > 1) fail(`CLI accepts at most one ${flag} argument.`);
  return count === 1;
}

async function runCli() {
  const addonPath = readCliArgument('--addon');
  const optionsPath = readCliArgument('--options');
  const catalogPath = readCliArgument('--catalog');
  const snapshotManifestPath = readCliArgument('--snapshot-manifest');
  const requireDownloadIdentity = readCliBooleanFlag('--require-catalog-download');
  const { addonBytes, optionsBytes, catalogBytes } = await loadVerifiedReleaseInputSnapshot({
    manifestPath: snapshotManifestPath,
    addonPath,
    optionsPath,
    catalogPath,
  });
  let options;
  try {
    options = JSON.parse(optionsBytes.toString('utf8'));
  } catch (error) {
    fail(`could not parse options JSON ${optionsPath}: ${error.message ?? String(error)}`);
  }
  const catalog = await loadCatalogForOptions(catalogPath, options, {
    requireDownloadIdentity,
    catalogBytes,
  });
  const result = validateAddonContract({ addonText: addonBytes.toString('utf8'), options, catalog });
  return {
    ok: true,
    catalogHash: result.catalogHash,
    emitted: result.emitted,
    skipped: result.skipped
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runCli()));
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  }
}
