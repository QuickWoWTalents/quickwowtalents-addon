import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import {
  loadNormalizedCatalog,
  validateAddonContract,
  validateImportStringForSpec
} from '../scripts/validate-addon-contract.mjs';
import { loadVerifiedCatalogSnapshot } from '../scripts/catalog-download-contract.mjs';

const execFileAsync = promisify(execFile);
const validatorPath = fileURLToPath(new URL('../scripts/validate-addon-contract.mjs', import.meta.url));
const currentArcaneFixture = JSON.parse(await fs.readFile(
  new URL('./fixtures/current-arcane-normalized-spec.json', import.meta.url),
  'utf8'
));

const BLIZZARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALID_IMPORT = 'C4DAAAAAAAAAAAAAAAAAAAAAA0DsB';
const CATALOG_DESCRIPTOR = {
  source: 'raidbots',
  environment: 'live',
  generatedAt: '2026-08-20T20:24:24.981Z',
  wowBuild: '12.1.0.69404',
  contentHash: 'ede9afa9b5123625aa8cb14d6941e755',
  clientInterface: 120100,
  specCount: 40
};

const BASE_SPEC = {
  specId: 62,
  fullNodeOrder: [1001, 1002, 1003, 1004],
  nodes: {
    1001: {
      id: 1001,
      type: 'single',
      maxRanks: 1,
      freeNode: true,
      entries: [{ id: 5011, maxRanks: 1 }]
    },
    1002: {
      id: 1002,
      type: 'single',
      maxRanks: 2,
      freeNode: false,
      entries: [{ id: 5012, maxRanks: 2 }]
    },
    1003: {
      id: 1003,
      type: 'choice',
      maxRanks: 1,
      freeNode: false,
      entries: [
        { id: 5013, maxRanks: 1 },
        { id: 5014, maxRanks: 1 }
      ]
    },
    1004: {
      id: 1004,
      type: 'single',
      maxRanks: 1,
      freeNode: false,
      entries: [{ id: 5015, maxRanks: 1 }]
    }
  },
  talents: {
    5011: { id: 5011, nodeId: 1001 },
    5012: { id: 5012, nodeId: 1002 },
    5013: { id: 5013, nodeId: 1003 },
    5014: { id: 5014, nodeId: 1003 },
    5015: { id: 5015, nodeId: 1004 }
  }
};

function makeSpecRecord(specId, key) {
  const [className, specName] = key.split(':');
  return {
    ...structuredClone(BASE_SPEC),
    specId,
    className,
    specName,
    sourceKey: `raidbots:${CATALOG_DESCRIPTOR.contentHash}:${key}`
  };
}

function makeCatalog() {
  const specs = {
    'Mage:Arcane': makeSpecRecord(62, 'Mage:Arcane')
  };
  for (let index = 1; index < 40; index += 1) {
    const key = `Test Class ${index}:Spec ${index}`;
    specs[key] = makeSpecRecord(1000 + index, key);
  }
  return {
    source: CATALOG_DESCRIPTOR.source,
    environment: CATALOG_DESCRIPTOR.environment,
    generatedAt: CATALOG_DESCRIPTOR.generatedAt,
    wowBuild: CATALOG_DESCRIPTOR.wowBuild,
    contentHash: CATALOG_DESCRIPTOR.contentHash,
    specs
  };
}

function makeOptions() {
  return {
    talentCatalog: structuredClone(CATALOG_DESCRIPTOR),
    mythicPlus: {
      expansionId: 11,
      zoneId: 51,
      dungeons: [
        { id: 12993, name: 'Windrunner Spire' },
        { id: 12825, name: 'Maisara Caverns' }
      ]
    },
    raid: {
      expansionId: 11,
      zoneId: 50,
      bosses: [
        { id: 3159, name: 'Rotmire', raidName: 'Sporefall', zoneId: 50 }
      ],
      difficulties: [{ id: 4, name: 'Heroic' }]
    }
  };
}

function allMatrixCoordinates(catalog) {
  const coordinates = [];
  for (const key of Object.keys(catalog.specs)) {
    coordinates.push({ key, mode: 'mplus', encounterId: 12993 });
    coordinates.push({ key, mode: 'mplus', encounterId: 12825 });
    coordinates.push({ key, mode: 'raid', encounterId: 3159 });
  }
  return coordinates;
}

function makeData(catalog) {
  const emittedCoordinate = 'Mage:Arcane:mplus:12993';
  const skipped = allMatrixCoordinates(catalog)
    .filter(({ key, mode, encounterId }) => `${key}:${mode}:${encounterId}` !== emittedCoordinate)
    .map((coordinate, index) => ({
      ...coordinate,
      encounterName: `Encounter ${coordinate.encounterId}`,
      code: index % 2 === 0 ? 'NO_USABLE_LOGS' : 'NO_COMPATIBLE_CURRENT_LOGS',
      reason: 'Explicit current-data gap.'
    }));

  return {
    schemaVersion: 3,
    source: 'https://quickwowtalents.com',
    generatedAt: '2026-08-25T12:00:00.000Z',
    clientInterface: 120100,
    talentCatalog: structuredClone(CATALOG_DESCRIPTOR),
    activities: {
      mythicPlus: {
        expansionId: 11,
        zoneId: 51,
        dungeonIds: [12993, 12825]
      },
      raid: {
        expansionId: 11,
        primaryZoneId: 50,
        difficultyId: 4,
        zones: [{ zoneId: 50, name: 'Sporefall', bossIds: [3159] }],
        bossIds: [3159]
      }
    },
    counts: {
      specs: 40,
      attempted: 120,
      emitted: 1,
      specsWithAnyRecommendation: 1,
      skipped: 119
    },
    recommendations: {
      62: {
        className: 'Mage',
        specName: 'Arcane',
        role: 'DPS',
        mplus: {
          encounters: {
            12993: {
              mode: 'mplus',
              className: 'Mage',
              specName: 'Arcane',
              dungeonId: 12993,
              importString: VALID_IMPORT
            }
          }
        },
        raid: { encounters: {} }
      }
    },
    skipped
  };
}

function makeFixture() {
  const catalog = makeCatalog();
  return { catalog, options: makeOptions(), data: makeData(catalog) };
}

function luaString(value) {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, (character) => (
    character === '\u2028' ? '\\u2028' : '\\u2029'
  ));
}

function toLua(value, indent = 0) {
  if (value === null) return 'nil';
  if (typeof value === 'string') return luaString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const entries = Array.isArray(value)
    ? value.map((item) => ({ key: null, value: item }))
    : Object.entries(value).map(([key, item]) => ({ key, value: item }));
  if (entries.length === 0) return '{}';

  const padding = ' '.repeat(indent + 2);
  const closingPadding = ' '.repeat(indent);
  const rendered = entries.map((entry) => {
    let key = '';
    if (entry.key !== null) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key)) key = `${entry.key} = `;
      else if (/^[1-9]\d*$/.test(entry.key)) key = `[${entry.key}] = `;
      else key = `[${luaString(entry.key)}] = `;
    }
    return `${padding}${key}${toLua(entry.value, indent + 2)}`;
  });
  return `{\n${rendered.join(',\n')}\n${closingPadding}}`;
}

function renderAddonData(data) {
  return `-- Generated fixture.\nQuickWoWTalentsData = ${toLua(data)}\n`;
}

async function writeSnapshotManifest(manifestPath, { addonPath, optionsPath, catalogPath }) {
  const [addonBytes, optionsBytes, catalogBytes] = await Promise.all([
    fs.readFile(addonPath),
    fs.readFile(optionsPath),
    fs.readFile(catalogPath),
  ]);
  const record = (bytes) => ({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    files: {
      options: record(optionsBytes),
      catalog: record(catalogBytes),
      addon: record(addonBytes),
    },
  })}\n`);
}

function validateFixture(fixture) {
  return validateAddonContract({
    addonText: renderAddonData(fixture.data),
    options: fixture.options,
    catalog: fixture.catalog
  });
}

function setBits(importString, offset, width, value) {
  const values = [...importString].map((character) => BLIZZARD_BASE64.indexOf(character));
  assert.ok(values.every((entry) => entry >= 0), 'fixture must use Blizzard base64');
  for (let bit = 0; bit < width; bit += 1) {
    const absoluteBit = offset + bit;
    const characterIndex = Math.floor(absoluteBit / 6);
    const bitIndex = absoluteBit % 6;
    const bitValue = Math.floor(value / (2 ** bit)) % 2;
    values[characterIndex] = (values[characterIndex] & ~(1 << bitIndex)) | (bitValue << bitIndex);
  }
  return values.map((entry) => BLIZZARD_BASE64[entry]).join('');
}

test('accepts a complete partial schema-3 matrix with both safe skip codes', () => {
  const result = validateFixture(makeFixture());

  assert.equal(result.data.schemaVersion, 3);
  assert.equal(result.catalogHash, CATALOG_DESCRIPTOR.contentHash);
  assert.equal(result.emitted, 1);
  assert.equal(result.skipped, 119);
});

test('rejects schema 2 before accepting addon data', () => {
  const fixture = makeFixture();
  fixture.data.schemaVersion = 2;

  assert.throws(() => validateFixture(fixture), /schema 3/i);
});

test('rejects a wrong top-level client interface', () => {
  const fixture = makeFixture();
  fixture.data.clientInterface = 120000;

  assert.throws(() => validateFixture(fixture), /client interface 120100/i);
});

test('rejects a catalog that is not independently a WoW 12.1 catalog', () => {
  const fixture = makeFixture();
  fixture.catalog.wowBuild = '12.0.5.70000';
  fixture.options.talentCatalog.wowBuild = fixture.catalog.wowBuild;
  fixture.data.talentCatalog.wowBuild = fixture.catalog.wowBuild;

  assert.throws(() => validateFixture(fixture), /WoW 12\.1/i);
});

test('rejects a catalog that is not independently Raidbots live', () => {
  const fixture = makeFixture();
  fixture.catalog.environment = 'ptr';
  fixture.options.talentCatalog.environment = 'ptr';
  fixture.data.talentCatalog.environment = 'ptr';

  assert.throws(() => validateFixture(fixture), /live/i);
});

test('rejects a catalog that does not independently contain 40 specs', () => {
  const fixture = makeFixture();
  delete fixture.catalog.specs['Test Class 39:Spec 39'];
  fixture.options.talentCatalog.specCount = 39;
  fixture.data.talentCatalog.specCount = 39;

  assert.throws(() => validateFixture(fixture), /40 specs/i);
});

test('rejects options and artifact catalog hash disagreement', () => {
  const fixture = makeFixture();
  fixture.data.talentCatalog.contentHash = 'stale-catalog-hash';

  assert.throws(() => validateFixture(fixture), /catalog.*contentHash|catalog hash/i);
});

test('uses the parsed catalog contentHash as catalog identity', () => {
  const fixture = makeFixture();
  fixture.catalog.contentHash = 'different-canonical-content-hash';

  assert.throws(() => validateFixture(fixture), /catalog.*contentHash|catalog hash/i);
});

test('requires options and artifact descriptors to contain exactly seven fields', () => {
  const fixture = makeFixture();
  fixture.options.talentCatalog.extraIdentity = 'not-canonical';
  fixture.data.talentCatalog.extraIdentity = 'not-canonical';

  assert.throws(() => validateFixture(fixture), /seven|descriptor fields|extraIdentity/i);
});

test('rejects reordered activity IDs even when the same IDs are present', () => {
  const fixture = makeFixture();
  fixture.data.activities.mythicPlus.dungeonIds.reverse();

  assert.throws(() => validateFixture(fixture), /activity|dungeon.*order|Mythic\+/i);
});

for (const [field, value] of [
  ['specs', 39],
  ['attempted', 119],
  ['emitted', 2],
  ['specsWithAnyRecommendation', 2],
  ['skipped', 118]
]) {
  test(`rejects an inconsistent counts.${field}`, () => {
    const fixture = makeFixture();
    fixture.data.counts[field] = value;

    assert.throws(() => validateFixture(fixture), new RegExp(field, 'i'));
  });
}

test('rejects skip codes outside the exact safe set', () => {
  const fixture = makeFixture();
  fixture.data.skipped[0].code = 'CACHE_MISS';

  assert.throws(() => validateFixture(fixture), /unknown skip code.*CACHE_MISS/i);
});

test('rejects duplicate recommendation/skip coordinates', () => {
  const fixture = makeFixture();
  fixture.data.skipped[0] = {
    ...fixture.data.skipped[0],
    key: 'Mage:Arcane',
    mode: 'mplus',
    encounterId: 12993
  };

  assert.throws(() => validateFixture(fixture), /duplicate.*coordinate/i);
});

test('rejects recommendation coordinates outside the activity matrix', () => {
  const fixture = makeFixture();
  const entry = fixture.data.recommendations[62].mplus.encounters[12993];
  delete fixture.data.recommendations[62].mplus.encounters[12993];
  fixture.data.recommendations[62].mplus.encounters[99999] = {
    ...entry,
    dungeonId: 99999
  };

  assert.throws(() => validateFixture(fixture), /outside.*matrix|unknown.*encounter/i);
});

test('maps every numeric recommendation key to exactly one catalog specId', () => {
  const fixture = makeFixture();
  fixture.data.recommendations[9999] = fixture.data.recommendations[62];
  delete fixture.data.recommendations[62];

  assert.throws(() => validateFixture(fixture), /specialization 9999|specId 9999/i);
});

test('rejects specialization table labels swapped away from the catalog record', () => {
  const fixture = makeFixture();
  fixture.data.recommendations[62].className = 'Test Class 1';
  fixture.data.recommendations[62].specName = 'Spec 1';

  assert.throws(() => validateFixture(fixture), /specialization.*className|catalog.*label|class.*spec.*mismatch/i);
});

test('rejects recommendation labels swapped away from the catalog record', () => {
  const fixture = makeFixture();
  const recommendation = fixture.data.recommendations[62].mplus.encounters[12993];
  recommendation.className = 'Test Class 1';
  recommendation.specName = 'Spec 1';

  assert.throws(() => validateFixture(fixture), /recommendation.*className|catalog.*label|class.*spec.*mismatch/i);
});

test('rejects a recommendation specialization written with a Lua string key', () => {
  const fixture = makeFixture();
  const numericLua = renderAddonData(fixture.data);
  const stringKeyLua = numericLua.replace('[62] = {', '["62"] = {');
  assert.notEqual(stringKeyLua, numericLua);

  assert.throws(
    () => validateAddonContract({ addonText: stringKeyLua, options: fixture.options, catalog: fixture.catalog }),
    /specialization.*explicit numeric Lua key/i
  );
});

test('rejects a recommendation encounter written with a Lua string key', () => {
  const fixture = makeFixture();
  const numericLua = renderAddonData(fixture.data);
  const stringKeyLua = numericLua.replace('[12993] = {', '["12993"] = {');
  assert.notEqual(stringKeyLua, numericLua);

  assert.throws(
    () => validateAddonContract({ addonText: stringKeyLua, options: fixture.options, catalog: fixture.catalog }),
    /encounter.*explicit numeric Lua key/i
  );
});

test('rejects an empty emitted import string', () => {
  const fixture = makeFixture();
  fixture.data.recommendations[62].mplus.encounters[12993].importString = '';

  assert.throws(() => validateFixture(fixture), /import string.*non-empty|empty import/i);
});

test('rejects an import whose selected choice resolves to an unknown talent ID', () => {
  const fixture = makeFixture();
  delete fixture.catalog.specs['Mage:Arcane'].talents[5014];

  assert.throws(() => validateFixture(fixture), /unknown talent 5014/i);
});

test('rejects a truncated import string', () => {
  const fixture = makeFixture();
  fixture.data.recommendations[62].mplus.encounters[12993].importString = VALID_IMPORT.slice(0, -1);

  assert.throws(() => validateFixture(fixture), /truncated/i);
});

test('decodes granted, partial-rank, and choice nodes in Blizzard bit order', () => {
  assert.equal(validateImportStringForSpec(VALID_IMPORT, BASE_SPEC), true);
});

test('rejects invalid Blizzard base64 alphabet, header version, and spec ID', () => {
  assert.throws(() => validateImportStringForSpec(`${VALID_IMPORT.slice(0, -1)}=`, BASE_SPEC), /base64 alphabet/i);
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 0, 8, 3), BASE_SPEC), /version 2/i);
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 8, 16, 63), BASE_SPEC), /spec.*63.*62|spec.*mismatch/i);
});

test('rejects any non-zero bit in the 128-bit Blizzard tree-hash header', () => {
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 24, 1, 1), BASE_SPEC), /tree hash.*zero/i);
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 151, 1, 1), BASE_SPEC), /tree hash.*zero/i);
});

test('rejects a selected node absent from the catalog spec record', () => {
  const spec = structuredClone(BASE_SPEC);
  delete spec.nodes[1003];

  assert.throws(() => validateImportStringForSpec(VALID_IMPORT, spec), /unknown node 1003/i);
});

test('rejects partial ranks at zero or at the node maximum', () => {
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 157, 6, 0), BASE_SPEC), /partial rank 0/i);
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 157, 6, 2), BASE_SPEC), /partial rank 2/i);
});

test('rejects a choice index outside the selected node entries', () => {
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 168, 2, 3), BASE_SPEC), /choice index 3/i);
});

test('rejects non-zero padding and trailing base64 characters', () => {
  assert.throws(() => validateImportStringForSpec(setBits(VALID_IMPORT, 171, 1, 1), BASE_SPEC), /padding/i);
  assert.throws(() => validateImportStringForSpec(`${VALID_IMPORT}A`, BASE_SPEC), /trailing/i);
});

test('loads the same normalized catalog from JSON and gzip without hashing file bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-catalog-'));
  const catalog = makeCatalog();
  const jsonPath = path.join(directory, 'talent-trees.json');
  const gzipPath = path.join(directory, 'talent-trees.json.gz');

  try {
    const json = JSON.stringify(catalog);
    await fs.writeFile(jsonPath, json);
    await fs.writeFile(gzipPath, gzipSync(json));

    assert.deepEqual(await loadNormalizedCatalog(jsonPath), catalog);
    assert.deepEqual(await loadNormalizedCatalog(gzipPath), catalog);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('validates a tracked real current Arcane import from the committed fixture', () => {
  assert.deepEqual(currentArcaneFixture.talentCatalog, CATALOG_DESCRIPTOR);
  assert.equal(currentArcaneFixture.specKey, 'Mage:Arcane');
  assert.equal(
    validateImportStringForSpec(currentArcaneFixture.importString, currentArcaneFixture.specRecord),
    true
  );
});

test('CLI validates explicit addon, options, and catalog inputs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-validator-cli-'));
  const fixture = makeFixture();
  const addonPath = path.join(directory, 'QuickWoWTalentsData.lua');
  const optionsPath = path.join(directory, 'options.json');
  const catalogPath = path.join(directory, 'talent-trees.json.gz');
  const snapshotManifestPath = path.join(directory, 'snapshot-manifest.json');

  try {
    await Promise.all([
      fs.writeFile(addonPath, renderAddonData(fixture.data)),
      fs.writeFile(optionsPath, JSON.stringify(fixture.options)),
      fs.writeFile(catalogPath, gzipSync(JSON.stringify(fixture.catalog)))
    ]);
    await writeSnapshotManifest(snapshotManifestPath, { addonPath, optionsPath, catalogPath });

    const { stdout } = await execFileAsync(process.execPath, [
      validatorPath,
      '--addon', addonPath,
      '--options', optionsPath,
      '--catalog', catalogPath,
      '--snapshot-manifest', snapshotManifestPath,
    ]);
    assert.deepEqual(JSON.parse(stdout), {
      ok: true,
      catalogHash: CATALOG_DESCRIPTOR.contentHash,
      emitted: 1,
      skipped: 119
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects a parsed catalog whose persisted gzip bytes do not match options download metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-validator-catalog-digest-'));
  const fixture = makeFixture();
  const addonPath = path.join(directory, 'QuickWoWTalentsData.lua');
  const optionsPath = path.join(directory, 'options.json');
  const catalogPath = path.join(directory, 'talent-catalog.json.gz');
  const snapshotManifestPath = path.join(directory, 'snapshot-manifest.json');
  const catalogText = JSON.stringify(fixture.catalog);
  const expectedBytes = gzipSync(catalogText, { level: 9 });
  const persistedBytes = gzipSync(catalogText, { level: 1 });
  assert.notDeepEqual(persistedBytes, expectedBytes);
  const sha256 = createHash('sha256').update(expectedBytes).digest('hex');
  fixture.options.talentCatalogDownload = {
    path: `/api/talent-catalog?sha256=${sha256}`,
    sha256,
    bytes: expectedBytes.length,
    mediaType: 'application/gzip',
  };

  try {
    await Promise.all([
      fs.writeFile(addonPath, renderAddonData(fixture.data)),
      fs.writeFile(optionsPath, JSON.stringify(fixture.options)),
      fs.writeFile(catalogPath, persistedBytes),
    ]);
    await writeSnapshotManifest(snapshotManifestPath, { addonPath, optionsPath, catalogPath });

    await assert.rejects(
      execFileAsync(process.execPath, [
        validatorPath,
        '--addon', addonPath,
        '--options', optionsPath,
        '--catalog', catalogPath,
        '--snapshot-manifest', snapshotManifestPath,
        '--require-catalog-download',
      ]),
      (error) => {
        assert.match(error.stderr, /catalog.*(?:SHA-256|byte length)/i);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CLI requires a snapshot manifest and rejects stale exact input bytes before parsing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-validator-snapshot-marker-'));
  const fixture = makeFixture();
  const addonPath = path.join(directory, 'QuickWoWTalentsData.lua');
  const optionsPath = path.join(directory, 'options.json');
  const catalogPath = path.join(directory, 'talent-trees.json');
  const snapshotManifestPath = path.join(directory, 'snapshot-manifest.json');
  try {
    await Promise.all([
      fs.writeFile(addonPath, renderAddonData(fixture.data)),
      fs.writeFile(optionsPath, JSON.stringify(fixture.options)),
      fs.writeFile(catalogPath, JSON.stringify(fixture.catalog)),
    ]);

    await assert.rejects(
      execFileAsync(process.execPath, [
        validatorPath,
        '--addon', addonPath,
        '--options', optionsPath,
        '--catalog', catalogPath,
      ]),
      (error) => {
        assert.match(error.stderr, /snapshot[- ]manifest/i);
        return true;
      },
    );

    await writeSnapshotManifest(snapshotManifestPath, { addonPath, optionsPath, catalogPath });
    const wrongVersionManifest = JSON.parse(await fs.readFile(snapshotManifestPath, 'utf8'));
    wrongVersionManifest.version = 2;
    await fs.writeFile(snapshotManifestPath, JSON.stringify(wrongVersionManifest));
    await assert.rejects(
      execFileAsync(process.execPath, [
        validatorPath,
        '--addon', addonPath,
        '--options', optionsPath,
        '--catalog', catalogPath,
        '--snapshot-manifest', snapshotManifestPath,
      ]),
      (error) => {
        assert.match(error.stderr, /manifest version must be exactly 1/i);
        return true;
      },
    );

    await writeSnapshotManifest(snapshotManifestPath, { addonPath, optionsPath, catalogPath });
    const staleOptions = await fs.readFile(optionsPath);
    staleOptions[0] = staleOptions[0] === 0x7b ? 0x5b : 0x7b;
    await fs.writeFile(optionsPath, staleOptions);
    await assert.rejects(
      execFileAsync(process.execPath, [
        validatorPath,
        '--addon', addonPath,
        '--options', optionsPath,
        '--catalog', catalogPath,
        '--snapshot-manifest', snapshotManifestPath,
      ]),
      (error) => {
        assert.match(error.stderr, /release input snapshot.*options SHA-256/i);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verified catalog loading rejects a sparse oversized file without using an unbounded read', async ({ mock }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-bounded-catalog-'));
  const catalogPath = path.join(directory, 'oversized-catalog.json.gz');
  const fixture = makeFixture();
  const advertisedBytes = gzipSync(JSON.stringify(fixture.catalog));
  const sha256 = createHash('sha256').update(advertisedBytes).digest('hex');
  fixture.options.talentCatalogDownload = {
    path: `/api/talent-catalog?sha256=${sha256}`,
    sha256,
    bytes: advertisedBytes.length,
    mediaType: 'application/gzip',
  };
  const handle = await fs.open(catalogPath, 'w');
  await handle.truncate(64 * 1024 * 1024);
  await handle.close();
  const unboundedRead = mock.method(fs, 'readFile', async () => {
    throw new Error('unbounded file read was used');
  });
  try {
    await assert.rejects(
      loadVerifiedCatalogSnapshot(catalogPath, fixture.options, { maxCompressedBytes: 1024 * 1024 }),
      /compressed catalog size.*limit/i,
    );
    assert.equal(unboundedRead.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
