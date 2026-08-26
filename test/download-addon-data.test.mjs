import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  addonDataHash,
  downloadAddonData,
  normalizeAddonDataForComparison,
  replaceFileAtomically
} from '../scripts/download-addon-data.mjs';
import { verifyReleaseReadiness } from '../scripts/verify-release-readiness.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/download-addon-data.mjs', import.meta.url));
const VALIDATOR = fileURLToPath(new URL('../scripts/validate-addon-contract.mjs', import.meta.url));
const OPTIONS_URL = 'https://quickwowtalents.com/api/options';
const ADDON_URL = 'https://quickwowtalents.com/api/addon-data';
const VALID_IMPORT = 'C4DAAAAAAAAAAAAAAAAAAAAAA0DsB';
const CATALOG_DESCRIPTOR = {
  source: 'raidbots', environment: 'live', generatedAt: '2026-08-20T20:24:24.981Z',
  wowBuild: '12.1.0.69404', contentHash: 'ede9afa9b5123625aa8cb14d6941e755',
  clientInterface: 120100, specCount: 40
};
const BASE_SPEC = {
  specId: 62, className: 'Mage', specName: 'Arcane', fullNodeOrder: [1001, 1002, 1003, 1004],
  nodes: {
    1001: { id: 1001, type: 'single', maxRanks: 1, freeNode: true, entries: [{ id: 5011, maxRanks: 1 }] },
    1002: { id: 1002, type: 'single', maxRanks: 2, freeNode: false, entries: [{ id: 5012, maxRanks: 2 }] },
    1003: { id: 1003, type: 'choice', maxRanks: 1, freeNode: false, entries: [{ id: 5013, maxRanks: 1 }, { id: 5014, maxRanks: 1 }] },
    1004: { id: 1004, type: 'single', maxRanks: 1, freeNode: false, entries: [{ id: 5015, maxRanks: 1 }] }
  },
  talents: {
    5011: { id: 5011, nodeId: 1001 }, 5012: { id: 5012, nodeId: 1002 },
    5013: { id: 5013, nodeId: 1003 }, 5014: { id: 5014, nodeId: 1003 },
    5015: { id: 5015, nodeId: 1004 }
  }
};

function makeFixture({ generatedAt = '2026-08-25T12:00:00.000Z' } = {}) {
  const catalog = {
    source: CATALOG_DESCRIPTOR.source, environment: CATALOG_DESCRIPTOR.environment,
    generatedAt: CATALOG_DESCRIPTOR.generatedAt, wowBuild: CATALOG_DESCRIPTOR.wowBuild,
    contentHash: CATALOG_DESCRIPTOR.contentHash, specs: { 'Mage:Arcane': structuredClone(BASE_SPEC) }
  };
  for (let index = 1; index < 40; index += 1) {
    const className = `Test Class ${index}`;
    const specName = `Spec ${index}`;
    catalog.specs[`${className}:${specName}`] = { specId: 1000 + index, className, specName };
  }
  const options = {
    talentCatalog: structuredClone(CATALOG_DESCRIPTOR),
    mythicPlus: { expansionId: 11, zoneId: 51, dungeons: [{ id: 12993, name: 'Windrunner Spire' }] },
    raid: {
      expansionId: 11, zoneId: 50,
      bosses: [{ id: 3159, name: 'Rotmire', raidName: 'Sporefall', zoneId: 50 }],
      difficulties: [{ id: 4, name: 'Heroic' }]
    }
  };
  const skipped = [];
  for (const key of Object.keys(catalog.specs)) {
    for (const [mode, encounterId] of [['mplus', 12993], ['raid', 3159]]) {
      if (key === 'Mage:Arcane' && mode === 'mplus') continue;
      skipped.push({ key, mode, encounterId, encounterName: `Encounter ${encounterId}`,
        code: skipped.length % 2 === 0 ? 'NO_USABLE_LOGS' : 'NO_COMPATIBLE_CURRENT_LOGS',
        reason: 'Explicit current-data gap.' });
    }
  }
  const data = {
    schemaVersion: 3, source: 'https://quickwowtalents.com', generatedAt, clientInterface: 120100,
    talentCatalog: structuredClone(CATALOG_DESCRIPTOR),
    activities: {
      mythicPlus: { expansionId: 11, zoneId: 51, dungeonIds: [12993] },
      raid: { expansionId: 11, primaryZoneId: 50, difficultyId: 4,
        zones: [{ zoneId: 50, name: 'Sporefall', bossIds: [3159] }], bossIds: [3159] }
    },
    counts: { specs: 40, attempted: 80, emitted: 1, specsWithAnyRecommendation: 1, skipped: 79 },
    recommendations: {
      62: { className: 'Mage', specName: 'Arcane', role: 'DPS',
        mplus: { encounters: { 12993: {
          mode: 'mplus', className: 'Mage', specName: 'Arcane', dungeonId: 12993, importString: VALID_IMPORT
        } } },
        raid: { encounters: {} } }
    },
    skipped
  };
  return { catalog, options, data };
}

function luaString(value) {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, (character) => character === '\u2028' ? '\\u2028' : '\\u2029');
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

async function withDownloadFixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const catalogPath = path.join(directory, 'talent-trees.json');
  const outputPath = path.join(directory, 'QuickWoWTalentsData.lua');
  const fixture = makeFixture();
  await fs.writeFile(catalogPath, JSON.stringify(fixture.catalog));
  try {
    return await run({ directory, catalogPath, outputPath, fixture });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function addCatalogDownload(fixture, catalogBytes = gzipSync(JSON.stringify(fixture.catalog))) {
  const sha256 = createHash('sha256').update(catalogBytes).digest('hex');
  fixture.options.talentCatalogDownload = {
    path: `/api/talent-catalog?sha256=${sha256}`,
    sha256,
    bytes: catalogBytes.length,
    mediaType: 'application/gzip',
  };
  return {
    catalogBytes,
    catalogUrl: `https://quickwowtalents.com/api/talent-catalog?sha256=${sha256}`,
  };
}

async function withRemoteDownloadFixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-remote-download-'));
  const optionsOutputPath = path.join(directory, 'release-inputs', 'options.json');
  const catalogOutputPath = path.join(directory, 'release-inputs', 'talent-catalog.json.gz');
  const snapshotManifestOutputPath = path.join(directory, 'release-inputs', 'snapshot-manifest.json');
  const outputPath = path.join(directory, 'QuickWoWTalentsData.lua');
  const fixture = makeFixture();
  const download = addCatalogDownload(fixture);
  try {
    return await run({
      directory,
      optionsOutputPath,
      catalogOutputPath,
      snapshotManifestOutputPath,
      outputPath,
      fixture,
      ...download,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function response(body, { status = 200, statusText = 'OK', headers = {}, url = '' } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    url,
    headers: { get: (name) => normalizedHeaders.get(name.toLowerCase()) ?? null },
    text: async () => bytes.toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function digestRecord(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return {
    sha256: createHash('sha256').update(value).digest('hex'),
    bytes: value.length,
  };
}

async function writeReadinessScaffolding(directory) {
  await Promise.all([
    fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' })),
    fs.writeFile(path.join(directory, 'QuickWoWTalents.toc'), '## Interface: 120100\n## Version: 1.2.3\n'),
    fs.writeFile(path.join(directory, '.pkgmeta'), 'manual-changelog:\n  filename: CURSEFORGE_CHANGELOG.md\n  markup-type: plain\n'),
    fs.writeFile(path.join(directory, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 - 2026-08-25\n\n- Current.\n'),
    fs.writeFile(path.join(directory, 'CURSEFORGE_CHANGELOG.md'), 'QuickWoWTalents 1.2.3 - 2026-08-25\n\n- Current.\n'),
  ]);
}

test('downloads and atomically persists the exact production catalog before addon validation', async () => {
  await withRemoteDownloadFixture(async ({
    directory,
    optionsOutputPath,
    catalogOutputPath,
    snapshotManifestOutputPath,
    outputPath,
    fixture,
    catalogBytes,
    catalogUrl,
  }) => {
    const originalFetch = globalThis.fetch;
    const optionsText = JSON.stringify(fixture.options, null, 2);
    const addonText = renderAddonData(fixture.data);
    const calls = [];
    const redirectModes = [];
    const committedPaths = [];
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      redirectModes.push(init?.redirect);
      if (String(url) === OPTIONS_URL) return response(optionsText);
      if (String(url) === catalogUrl) {
        return response(catalogBytes, { headers: { 'content-type': 'application/gzip' } });
      }
      if (String(url) === ADDON_URL) return response(addonText);
      throw new Error('Unexpected test URL.');
    };
    try {
      const result = await downloadAddonData({
        url: ADDON_URL,
        optionsUrl: OPTIONS_URL,
        optionsOutputPath,
        catalogOutputPath,
        snapshotManifestOutputPath,
        outputPath,
        timeoutMs: 1000,
        async renameFile(from, to) {
          committedPaths.push(path.basename(to));
          await fs.rename(from, to);
        },
      });
      assert.deepEqual(calls, [OPTIONS_URL, catalogUrl, ADDON_URL]);
      assert.deepEqual(redirectModes, ['manual', 'manual', 'manual']);
      assert.equal(await fs.readFile(optionsOutputPath, 'utf8'), optionsText);
      assert.deepEqual(await fs.readFile(catalogOutputPath), catalogBytes);
      assert.equal(await fs.readFile(outputPath, 'utf8'), addonText);
      assert.equal(result.catalogOutputPath, catalogOutputPath);
      assert.equal(result.catalogSha256, fixture.options.talentCatalogDownload.sha256);
      assert.equal(result.snapshotManifestOutputPath, snapshotManifestOutputPath);
      assert.deepEqual(committedPaths, [
        'options.json',
        'talent-catalog.json.gz',
        'QuickWoWTalentsData.lua',
        'snapshot-manifest.json',
      ]);
      assert.deepEqual(JSON.parse(await fs.readFile(snapshotManifestOutputPath, 'utf8')), {
        version: 1,
        files: {
          options: digestRecord(optionsText),
          catalog: digestRecord(catalogBytes),
          addon: digestRecord(addonText),
        },
      });
      assert.deepEqual(
        (await fs.readdir(path.join(directory, 'release-inputs'))).sort(),
        ['options.json', 'snapshot-manifest.json', 'talent-catalog.json.gz'],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('rejects aliased conceptual snapshot destinations before fetch when addon bytes are unchanged', async () => {
  await withRemoteDownloadFixture(async ({
    optionsOutputPath,
    catalogOutputPath,
    outputPath,
    fixture,
    catalogBytes,
    catalogUrl,
  }) => {
    const originalFetch = globalThis.fetch;
    const addonText = renderAddonData(fixture.data);
    await fs.writeFile(outputPath, addonText);
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === catalogUrl) return response(catalogBytes);
      if (String(url) === ADDON_URL) return response(addonText);
      throw new Error('Unexpected test URL.');
    };

    try {
      await assert.rejects(
        downloadAddonData({
          optionsOutputPath,
          catalogOutputPath,
          snapshotManifestOutputPath: outputPath,
          outputPath,
        }),
        /snapshot output paths must be distinct/i,
      );
      assert.equal(fetchCount, 0);
      assert.equal(await fs.readFile(outputPath, 'utf8'), addonText);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

for (const redirectCase of [
  {
    name: 'same-origin options redirect',
    location: 'https://quickwowtalents.com/api/options-v2',
    stage: 'options',
  },
  {
    name: 'cross-origin catalog redirect',
    location: 'https://downloads.example.test/catalog.json.gz',
    stage: 'catalog',
  },
]) {
  test(`rejects ${redirectCase.name} before accepting a redirected body`, async () => {
    await withRemoteDownloadFixture(async ({ catalogOutputPath, outputPath, fixture, catalogUrl }) => {
      const originalFetch = globalThis.fetch;
      const calls = [];
      let bodyReads = 0;
      const redirectResponse = {
        ...response('must not be accepted', {
          status: 302,
          headers: { location: redirectCase.location },
        }),
        text: async () => { bodyReads += 1; return 'must not be accepted'; },
        arrayBuffer: async () => { bodyReads += 1; return new ArrayBuffer(0); },
      };
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), redirect: init?.redirect });
        if (redirectCase.stage === 'options') return redirectResponse;
        if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
        if (String(url) === catalogUrl) return redirectResponse;
        throw new Error('A redirected destination or addon body must not be fetched.');
      };
      try {
        await assert.rejects(
          downloadAddonData({ catalogOutputPath, outputPath }),
          /redirect/i,
        );
        assert.equal(bodyReads, 0);
        assert.deepEqual(calls, redirectCase.stage === 'options'
          ? [{ url: OPTIONS_URL, redirect: 'manual' }]
          : [
            { url: OPTIONS_URL, redirect: 'manual' },
            { url: catalogUrl, redirect: 'manual' },
          ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test('rejects a successful response whose final URL differs from the requested options URL', async () => {
  await withRemoteDownloadFixture(async ({ catalogOutputPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    let bodyReads = 0;
    globalThis.fetch = async () => ({
      ...response(JSON.stringify(fixture.options), {
        url: 'https://quickwowtalents.com/api/options-v2',
      }),
      text: async () => { bodyReads += 1; return JSON.stringify(fixture.options); },
    });
    try {
      await assert.rejects(
        downloadAddonData({ catalogOutputPath, outputPath }),
        /final URL|redirect/i,
      );
      assert.equal(bodyReads, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('rejects a downloaded catalog descriptor mismatch before fetching addon data or replacing outputs', async () => {
  await withRemoteDownloadFixture(async ({
    directory,
    optionsOutputPath,
    catalogOutputPath,
    outputPath,
    fixture,
    catalogBytes,
    catalogUrl,
  }) => {
    const originalFetch = globalThis.fetch;
    const sentinels = {
      options: Buffer.from('old options'),
      catalog: Buffer.from('old catalog'),
      addon: Buffer.from('old addon'),
    };
    await fs.mkdir(path.dirname(optionsOutputPath), { recursive: true });
    await Promise.all([
      fs.writeFile(optionsOutputPath, sentinels.options),
      fs.writeFile(catalogOutputPath, sentinels.catalog),
      fs.writeFile(outputPath, sentinels.addon),
    ]);
    fixture.options.talentCatalog.contentHash = 'different-canonical-catalog';
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === catalogUrl) return response(catalogBytes);
      if (String(url) === ADDON_URL) throw new Error('Addon fetch must not run.');
      throw new Error('Unexpected test URL.');
    };
    try {
      await assert.rejects(
        downloadAddonData({
          url: ADDON_URL,
          optionsUrl: OPTIONS_URL,
          optionsOutputPath,
          catalogOutputPath,
          outputPath,
        }),
        /catalog descriptor|contentHash/i,
      );
      assert.deepEqual(calls, [OPTIONS_URL, catalogUrl]);
      assert.deepEqual(await fs.readFile(optionsOutputPath), sentinels.options);
      assert.deepEqual(await fs.readFile(catalogOutputPath), sentinels.catalog);
      assert.deepEqual(await fs.readFile(outputPath), sentinels.addon);
      assert.deepEqual(
        (await fs.readdir(path.join(directory, 'release-inputs'))).sort(),
        ['options.json', 'talent-catalog.json.gz'],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('remote artifact validation failure leaves options, catalog, and addon destinations unchanged', async () => {
  await withRemoteDownloadFixture(async ({
    directory,
    optionsOutputPath,
    catalogOutputPath,
    outputPath,
    fixture,
    catalogBytes,
    catalogUrl,
  }) => {
    const originalFetch = globalThis.fetch;
    const sentinels = {
      options: Buffer.from('previous options'),
      catalog: Buffer.from('previous catalog'),
      addon: Buffer.from('previous addon'),
    };
    await fs.mkdir(path.dirname(optionsOutputPath), { recursive: true });
    await Promise.all([
      fs.writeFile(optionsOutputPath, sentinels.options),
      fs.writeFile(catalogOutputPath, sentinels.catalog),
      fs.writeFile(outputPath, sentinels.addon),
    ]);
    fixture.data.schemaVersion = 2;
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === catalogUrl) return response(catalogBytes);
      if (String(url) === ADDON_URL) return response(renderAddonData(fixture.data));
      throw new Error('Unexpected test URL.');
    };
    try {
      await assert.rejects(
        downloadAddonData({ optionsOutputPath, catalogOutputPath, outputPath }),
        /schema 3/i,
      );
      assert.deepEqual(await fs.readFile(optionsOutputPath), sentinels.options);
      assert.deepEqual(await fs.readFile(catalogOutputPath), sentinels.catalog);
      assert.deepEqual(await fs.readFile(outputPath), sentinels.addon);
      assert.deepEqual(
        (await fs.readdir(path.join(directory, 'release-inputs'))).sort(),
        ['options.json', 'talent-catalog.json.gz'],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

for (const [name, mutate, expectedError] of [
  ['extra descriptor field', (options) => { options.talentCatalogDownload.extra = true; }, /exactly.*four|descriptor fields/i],
  ['cross-origin path', (options) => { options.talentCatalogDownload.path = 'https://attacker.example/catalog.gz'; }, /same-origin|catalog download path/i],
  ['protocol-relative path', (options) => { options.talentCatalogDownload.path = '//attacker.example/catalog.gz'; }, /same-origin|catalog download path/i],
  ['wrong media type', (options) => { options.talentCatalogDownload.mediaType = 'application/json'; }, /application\/gzip|media type/i],
  ['invalid digest', (options) => { options.talentCatalogDownload.sha256 = 'ABC123'; }, /SHA-256|64 lowercase/i],
]) {
  test(`rejects catalog download metadata with ${name}`, async () => {
    await withRemoteDownloadFixture(async ({ optionsOutputPath, catalogOutputPath, outputPath, fixture }) => {
      const originalFetch = globalThis.fetch;
      mutate(fixture.options);
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return response(JSON.stringify(fixture.options));
      };
      try {
        await assert.rejects(
          downloadAddonData({ optionsOutputPath, catalogOutputPath, outputPath }),
          expectedError,
        );
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test('rejects remote catalog acquisition when the configured options URL is not HTTPS', async () => {
  await withRemoteDownloadFixture(async ({ catalogOutputPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response(JSON.stringify(fixture.options));
    };
    try {
      await assert.rejects(
        downloadAddonData({
          optionsUrl: 'http://quickwowtalents.com/api/options',
          catalogOutputPath,
          outputPath,
        }),
        /HTTPS/i,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

for (const [name, catalogResponse, expectedError] of [
  ['wrong response media type', ({ catalogBytes }) => response(catalogBytes, { headers: { 'content-type': 'application/octet-stream' } }), /media type|content-type/i],
  ['content encoding', ({ catalogBytes }) => response(catalogBytes, { headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' } }), /content encoding/i],
  ['wrong byte length', ({ catalogBytes }) => response(catalogBytes.subarray(0, catalogBytes.length - 1)), /byte length/i],
  ['wrong SHA-256', ({ catalogBytes }) => {
    const changed = Buffer.from(catalogBytes);
    changed[Math.floor(changed.length / 2)] ^= 1;
    return response(changed);
  }, /SHA-256/i],
]) {
  test(`rejects a catalog response with ${name} without replacing validated destinations`, async () => {
    await withRemoteDownloadFixture(async (context) => {
      const { directory, optionsOutputPath, catalogOutputPath, outputPath, fixture, catalogUrl } = context;
      const originalFetch = globalThis.fetch;
      const originalAddon = Buffer.from('existing addon snapshot');
      await fs.writeFile(outputPath, originalAddon);
      globalThis.fetch = async (url) => {
        if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
        if (String(url) === catalogUrl) return catalogResponse(context);
        throw new Error('Addon fetch must not run.');
      };
      try {
        await assert.rejects(
          downloadAddonData({ optionsOutputPath, catalogOutputPath, outputPath }),
          expectedError,
        );
        assert.deepEqual(await fs.readFile(outputPath), originalAddon);
        await assert.rejects(fs.access(optionsOutputPath), /ENOENT/);
        await assert.rejects(fs.access(catalogOutputPath), /ENOENT/);
        assert.deepEqual((await fs.readdir(directory)).sort(), ['QuickWoWTalentsData.lua']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test('rejects corrupt gzip bytes even when their length and SHA match the options metadata', async () => {
  await withRemoteDownloadFixture(async ({ catalogOutputPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    const corruptBytes = Buffer.from('not a gzip catalog');
    const { catalogUrl } = addCatalogDownload(fixture, corruptBytes);
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === catalogUrl) return response(corruptBytes);
      throw new Error('Addon fetch must not run.');
    };
    try {
      await assert.rejects(
        downloadAddonData({ catalogOutputPath, outputPath }),
        /gzip|catalog.*parse/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('enforces compressed and expanded catalog size limits before fetching addon data', async () => {
  for (const limitKind of ['compressed', 'expanded']) {
    await withRemoteDownloadFixture(async ({ catalogOutputPath, outputPath, fixture, catalogBytes, catalogUrl }) => {
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
        if (String(url) === catalogUrl) return response(catalogBytes);
        throw new Error('Addon fetch must not run.');
      };
      try {
        await assert.rejects(
          downloadAddonData({
            catalogOutputPath,
            outputPath,
            maxCatalogCompressedBytes: limitKind === 'compressed' ? catalogBytes.length - 1 : catalogBytes.length,
            maxCatalogExpandedBytes: limitKind === 'expanded' ? 32 : 1024 * 1024,
          }),
          new RegExp(`${limitKind}.*size|size.*${limitKind}`, 'i'),
        );
        assert.deepEqual(
          calls,
          limitKind === 'compressed' ? [OPTIONS_URL] : [OPTIONS_URL, catalogUrl],
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test('retries a transient catalog response with the existing retry policy', async () => {
  await withRemoteDownloadFixture(async ({ catalogOutputPath, outputPath, fixture, catalogBytes, catalogUrl }) => {
    const originalFetch = globalThis.fetch;
    const addonText = renderAddonData(fixture.data);
    let catalogAttempts = 0;
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === catalogUrl) {
        catalogAttempts += 1;
        return catalogAttempts === 1
          ? response('unavailable', { status: 503, statusText: 'Service Unavailable' })
          : response(catalogBytes);
      }
      if (String(url) === ADDON_URL) return response(addonText);
      throw new Error('Unexpected test URL.');
    };
    try {
      const result = await downloadAddonData({
        catalogOutputPath,
        outputPath,
        retries: 1,
        retryDelayMs: 0,
      });
      assert.equal(catalogAttempts, 2);
      assert.equal(result.changed, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('download failures do not expose response bytes or URL credentials and query data', async () => {
  const originalFetch = globalThis.fetch;
  const optionsUrl = 'https://username:password@quickwowtalents.com/api/options?token=top-secret-query';
  globalThis.fetch = async () => response('top-secret-response', { status: 401, statusText: 'Unauthorized' });
  try {
    await assert.rejects(
      downloadAddonData({
        optionsUrl,
        catalogOutputPath: '/unused/catalog.json.gz',
        outputPath: '/unused/addon.lua',
      }),
      (error) => {
        assert.match(error.message, /Options.*401/i);
        assert.doesNotMatch(error.message, /password|top-secret|username|token=/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const localFormat of ['json', 'recompressed-gzip']) {
  test(`local ${localFormat} catalog remains a semantic offline input when options advertise production archive bytes`, async () => {
    await withDownloadFixture(async ({ directory, catalogPath: jsonCatalogPath, outputPath, fixture }) => {
      const originalFetch = globalThis.fetch;
      const advertisedBytes = gzipSync(JSON.stringify(fixture.catalog), { level: 9 });
      addCatalogDownload(fixture, advertisedBytes);
      let catalogPath = jsonCatalogPath;
      if (localFormat === 'recompressed-gzip') {
        const localBytes = gzipSync(JSON.stringify(fixture.catalog), { level: 1 });
        assert.notDeepEqual(localBytes, advertisedBytes);
        catalogPath = path.join(directory, 'talent-trees.json.gz');
        await fs.writeFile(catalogPath, localBytes);
      }
      globalThis.fetch = async (url) => {
        if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
        if (String(url) === ADDON_URL) return response(renderAddonData(fixture.data));
        throw new Error('Offline catalog mode must not fetch the advertised catalog archive.');
      };
      try {
        const result = await downloadAddonData({ catalogPath, outputPath });
        assert.equal(result.changed, true);
        assert.equal(result.catalogOutputPath, null);
        assert.equal(await fs.readFile(outputPath, 'utf8'), renderAddonData(fixture.data));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test('uses product endpoint defaults, validates safe gaps, and reports schema-3 counts', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const addonText = renderAddonData(fixture.data);
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === ADDON_URL) return response(addonText);
      throw new Error(`Unexpected URL: ${url}`);
    };
    try {
      const result = await downloadAddonData({ catalogPath, outputPath, timeoutMs: 1000 });
      assert.deepEqual(calls, [OPTIONS_URL, ADDON_URL]);
      assert.equal(await fs.readFile(outputPath, 'utf8'), addonText);
      assert.equal(result.emitted, 1);
      assert.equal(result.skipped, 79);
      assert.equal(result.partial, true);
      assert.equal(result.recommendations, undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
});

for (const [name, mutate, expectedError] of [
  ['catalog descriptors disagree', (fixture) => { fixture.data.talentCatalog.contentHash = 'stale-catalog-hash'; }, /catalog.*contentHash/i],
  ['activity identities disagree', (fixture) => { fixture.data.activities.mythicPlus.dungeonIds = [99999]; }, /activity|dungeon.*order|Mythic\+/i]
]) {
  test(`preserves the existing file byte-for-byte when ${name}`, async () => {
    await withDownloadFixture(async ({ directory, catalogPath, outputPath, fixture }) => {
      const originalFetch = globalThis.fetch;
      const originalBytes = Buffer.from([0, 255, 13, 10, 65, 0, 66]);
      await fs.writeFile(outputPath, originalBytes);
      mutate(fixture);
      globalThis.fetch = async (url) => String(url) === OPTIONS_URL
        ? response(JSON.stringify(fixture.options)) : response(renderAddonData(fixture.data));
      try {
        await assert.rejects(downloadAddonData({ url: ADDON_URL, optionsUrl: OPTIONS_URL,
          catalogPath, outputPath, timeoutMs: 1000 }), expectedError);
        assert.deepEqual(await fs.readFile(outputPath), originalBytes);
        assert.deepEqual((await fs.readdir(directory)).sort(), ['QuickWoWTalentsData.lua', 'talent-trees.json']);
      } finally { globalThis.fetch = originalFetch; }
    });
  });
}

test('preserves the existing file when fetched options are not valid JSON', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    const originalText = 'existing addon bytes\r\n';
    await fs.writeFile(outputPath, originalText);
    globalThis.fetch = async (url) => String(url) === OPTIONS_URL
      ? response('{not-json') : response(renderAddonData(fixture.data));
    try {
      await assert.rejects(downloadAddonData({ url: ADDON_URL, optionsUrl: OPTIONS_URL, catalogPath, outputPath }), /options JSON/i);
      assert.equal(await fs.readFile(outputPath, 'utf8'), originalText);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('requires an explicit normalized catalog path before fetching', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  try {
    await assert.rejects(downloadAddonData({ url: ADDON_URL, optionsUrl: OPTIONS_URL, outputPath: '/unused' }), /catalog path/i);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('retries retriable failures from both endpoints', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    const attempts = { options: 0, addon: 0 };
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) {
        attempts.options += 1;
        return attempts.options === 1
          ? response('temporarily unavailable', { status: 503, statusText: 'Service Unavailable' })
          : response(JSON.stringify(fixture.options));
      }
      attempts.addon += 1;
      return attempts.addon === 1
        ? response('{"code":"ADDON_DATA_INCOMPLETE"}', { status: 503, statusText: 'Service Unavailable' })
        : response(renderAddonData(fixture.data));
    };
    try {
      const result = await downloadAddonData({ url: ADDON_URL, optionsUrl: OPTIONS_URL,
        catalogPath, outputPath, timeoutMs: 1000, retries: 1, retryDelayMs: 0 });
      assert.deepEqual(attempts, { options: 2, addon: 2 });
      assert.equal(result.changed, true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('retries an unreadable 503 response using its known HTTP status', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    let optionsAttempts = 0;
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) {
        optionsAttempts += 1;
        if (optionsAttempts === 1) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => { throw new Error('response stream reset'); }
          };
        }
        return response(JSON.stringify(fixture.options));
      }
      return response(renderAddonData(fixture.data));
    };
    try {
      const result = await downloadAddonData({ catalogPath, outputPath, retries: 1, retryDelayMs: 0 });
      assert.equal(optionsAttempts, 2);
      assert.equal(result.changed, true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('retries a body-stream failure from a successful response', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    let optionsAttempts = 0;
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) {
        optionsAttempts += 1;
        if (optionsAttempts === 1) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => { throw new Error('response stream reset'); }
          };
        }
        return response(JSON.stringify(fixture.options));
      }
      return response(renderAddonData(fixture.data));
    };
    try {
      await downloadAddonData({ catalogPath, outputPath, retries: 1, retryDelayMs: 0 });
      assert.equal(optionsAttempts, 2);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('does not retry a non-retriable 4xx response with deceptive transient text', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath }) => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return response('temporarily unavailable; please retry', { status: 400, statusText: 'Bad Request' });
    };
    try {
      await assert.rejects(
        downloadAddonData({ catalogPath, outputPath, retries: 2, retryDelayMs: 0 }),
        /Options.*400/
      );
      assert.equal(attempts, 1);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('atomically replaces a valid destination when validated non-timestamp data changes', async () => {
  await withDownloadFixture(async ({ directory, catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    const previousText = renderAddonData(fixture.data);
    const nextData = structuredClone(fixture.data);
    nextData.skipped[0].reason = 'A different explicit current-data gap.';
    const nextText = renderAddonData(nextData);
    const nextBytes = Buffer.from(nextText, 'utf8');
    await fs.writeFile(outputPath, previousText);
    globalThis.fetch = async (url) => String(url) === OPTIONS_URL
      ? response(JSON.stringify(fixture.options)) : response(nextText);
    try {
      const result = await downloadAddonData({ catalogPath, outputPath });
      assert.equal(result.changed, true);
      assert.equal(result.previousHash, addonDataHash(previousText));
      assert.equal(result.hash, addonDataHash(nextText));
      assert.notEqual(result.hash, result.previousHash);
      assert.equal(result.bytes, Buffer.byteLength(nextText));
      assert.deepEqual(await fs.readFile(outputPath), nextBytes);
      assert.deepEqual((await fs.readdir(directory)).sort(), ['QuickWoWTalentsData.lua', 'talent-trees.json']);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('does not unlink an unowned sibling when exclusive temp creation collides', async () => {
  await withDownloadFixture(async ({ directory, outputPath }) => {
    const destinationBytes = Buffer.from('existing destination');
    const collisionBytes = Buffer.from('owned by another invocation');
    const collisionPath = path.join(
      directory,
      `.${path.basename(outputPath)}.${process.pid}.collision.tmp`
    );
    await fs.writeFile(outputPath, destinationBytes);
    await fs.writeFile(collisionPath, collisionBytes);

    await assert.rejects(
      replaceFileAtomically(outputPath, 'new data', {
        createTemporaryId: () => 'collision'
      }),
      (error) => error.code === 'EEXIST'
    );
    assert.deepEqual(await fs.readFile(outputPath), destinationBytes);
    assert.deepEqual(await fs.readFile(collisionPath), collisionBytes);
  });
});

test('remote snapshot staging cleans owned temps and preserves every destination on collision', async () => {
  await withRemoteDownloadFixture(async ({
    directory,
    optionsOutputPath,
    catalogOutputPath,
    outputPath,
    fixture,
    catalogBytes,
    catalogUrl,
  }) => {
    const originalFetch = globalThis.fetch;
    const originalOptions = Buffer.from('existing options');
    const originalCatalog = Buffer.from('existing catalog');
    const originalAddon = Buffer.from('existing addon');
    await fs.mkdir(path.dirname(optionsOutputPath), { recursive: true });
    await Promise.all([
      fs.writeFile(optionsOutputPath, originalOptions),
      fs.writeFile(catalogOutputPath, originalCatalog),
      fs.writeFile(outputPath, originalAddon),
    ]);
    const collisionPath = path.join(
      path.dirname(catalogOutputPath),
      `.${path.basename(catalogOutputPath)}.${process.pid}.collision.tmp`,
    );
    const collisionBytes = Buffer.from('owned by a different downloader');
    await fs.writeFile(collisionPath, collisionBytes);
    globalThis.fetch = async (url) => {
      if (String(url) === OPTIONS_URL) return response(JSON.stringify(fixture.options));
      if (String(url) === catalogUrl) return response(catalogBytes);
      if (String(url) === ADDON_URL) return response(renderAddonData(fixture.data));
      throw new Error('Unexpected test URL.');
    };

    try {
      await assert.rejects(
        downloadAddonData({
          optionsOutputPath,
          catalogOutputPath,
          outputPath,
          createTemporaryId: () => 'collision',
        }),
        (error) => error.code === 'EEXIST',
      );
      assert.deepEqual(await fs.readFile(optionsOutputPath), originalOptions);
      assert.deepEqual(await fs.readFile(catalogOutputPath), originalCatalog);
      assert.deepEqual(await fs.readFile(outputPath), originalAddon);
      assert.deepEqual(await fs.readFile(collisionPath), collisionBytes);
      assert.deepEqual(
        (await fs.readdir(path.dirname(optionsOutputPath))).sort(),
        ['.talent-catalog.json.gz.' + process.pid + '.collision.tmp', 'options.json', 'talent-catalog.json.gz'],
      );
      assert.deepEqual((await fs.readdir(directory)).sort(), ['QuickWoWTalentsData.lua', 'release-inputs']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

for (const committedTargetCount of [1, 2]) {
  test(`an interrupted remote commit after ${committedTargetCount} target rename(s) leaves a stale marker that validation and readiness reject`, async () => {
    await withRemoteDownloadFixture(async ({
      directory,
      optionsOutputPath,
      catalogOutputPath,
      snapshotManifestOutputPath,
      outputPath,
      fixture,
      catalogBytes,
      catalogUrl,
    }) => {
      const originalFetch = globalThis.fetch;
      await writeReadinessScaffolding(directory);
      let active = {
        optionsText: JSON.stringify(fixture.options),
        catalogBytes,
        catalogUrl,
        addonText: renderAddonData(fixture.data),
      };
      globalThis.fetch = async (url) => {
        if (String(url) === OPTIONS_URL) return response(active.optionsText);
        if (String(url) === active.catalogUrl) return response(active.catalogBytes);
        if (String(url) === ADDON_URL) return response(active.addonText);
        throw new Error('Unexpected test URL.');
      };

      try {
        await downloadAddonData({
          optionsOutputPath,
          catalogOutputPath,
          snapshotManifestOutputPath,
          outputPath,
        });
        const committedManifest = await fs.readFile(snapshotManifestOutputPath);

        const nextFixture = makeFixture();
        nextFixture.data.skipped[0].reason = 'A different explicit current-data gap.';
        const nextCatalogBytes = gzipSync(JSON.stringify(nextFixture.catalog), { level: 1 });
        assert.notDeepEqual(nextCatalogBytes, catalogBytes);
        const nextDownload = addCatalogDownload(nextFixture, nextCatalogBytes);
        active = {
          optionsText: JSON.stringify(nextFixture.options, null, 2),
          catalogBytes: nextCatalogBytes,
          catalogUrl: nextDownload.catalogUrl,
          addonText: renderAddonData(nextFixture.data),
        };

        let renameAttempts = 0;
        await assert.rejects(
          downloadAddonData({
            optionsOutputPath,
            catalogOutputPath,
            snapshotManifestOutputPath,
            outputPath,
            async renameFile(from, to) {
              renameAttempts += 1;
              if (renameAttempts === committedTargetCount + 1) {
                const error = new Error('injected rename failure');
                error.code = 'EIO';
                throw error;
              }
              await fs.rename(from, to);
            },
          }),
          /injected rename failure/,
        );
        assert.equal(renameAttempts, committedTargetCount + 1);
        assert.deepEqual(await fs.readFile(snapshotManifestOutputPath), committedManifest);

        const validation = spawnSync(process.execPath, [
          VALIDATOR,
          '--addon', outputPath,
          '--options', optionsOutputPath,
          '--catalog', catalogOutputPath,
          '--snapshot-manifest', snapshotManifestOutputPath,
          '--require-catalog-download',
        ], { encoding: 'utf8' });
        assert.notEqual(validation.status, 0);
        assert.match(validation.stderr, /release input snapshot.*(?:SHA-256|byte length)/i);

        await assert.rejects(
          verifyReleaseReadiness({
            repoRoot: directory,
            optionsPath: optionsOutputPath,
            catalogPath: catalogOutputPath,
            snapshotManifestPath: snapshotManifestOutputPath,
            requireCatalogDownload: true,
            skipZip: true,
          }),
          /release input snapshot.*(?:SHA-256|byte length)/i,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test('normalizes timestamp-only changes after validation and avoids replacement', async () => {
  await withDownloadFixture(async ({ catalogPath, outputPath, fixture }) => {
    const originalFetch = globalThis.fetch;
    const firstText = renderAddonData(fixture.data);
    const nextFixture = makeFixture({ generatedAt: '2026-08-26T12:00:00.000Z' });
    const nextText = renderAddonData(nextFixture.data);
    await fs.writeFile(outputPath, firstText);
    globalThis.fetch = async (url) => String(url) === OPTIONS_URL
      ? response(JSON.stringify(nextFixture.options)) : response(nextText);
    try {
      const result = await downloadAddonData({ url: ADDON_URL, optionsUrl: OPTIONS_URL, catalogPath, outputPath });
      assert.equal(result.changed, false);
      assert.equal(await fs.readFile(outputPath, 'utf8'), firstText);
      assert.equal(normalizeAddonDataForComparison(firstText), normalizeAddonDataForComparison(nextText));
      assert.equal(addonDataHash(firstText), addonDataHash(nextText));
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('CLI persists the exact validated options snapshot for later readiness checks', async () => {
  await withDownloadFixture(async ({ directory, catalogPath, outputPath, fixture }) => {
    const optionsText = JSON.stringify(fixture.options, null, 2);
    const optionsOutputPath = path.join(directory, 'release-inputs', 'options.json');
    const optionsUrl = `data:application/json,${encodeURIComponent(optionsText)}`;
    const addonText = renderAddonData(fixture.data);
    const addonUrl = `data:text/plain,${encodeURIComponent(addonText)}`;
    const result = spawnSync(process.execPath, [SCRIPT, '--url', addonUrl, '--options-url', optionsUrl,
      '--options-output', optionsOutputPath, '--catalog', catalogPath, '--output', outputPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(outputPath, 'utf8'), addonText);
    assert.equal(await fs.readFile(optionsOutputPath, 'utf8'), optionsText);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.emitted, 1);
    assert.equal(summary.skipped, 79);
    assert.equal(summary.optionsSource, optionsUrl);
    assert.equal(summary.optionsOutputPath, optionsOutputPath);
  });
});
