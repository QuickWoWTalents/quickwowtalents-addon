import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { addonDataHash, downloadAddonData, normalizeAddonDataForComparison } from '../scripts/download-addon-data.mjs';

const SCRIPT = new URL('../scripts/download-addon-data.mjs', import.meta.url).pathname;

function validAddonLua({ generatedAt = '2026-05-01T00:00:00.000Z', importString = 'MPLUS' } = {}) {
  return [
    'QuickWoWTalentsData = {',
    '  schemaVersion = 2,',
    `  generatedAt = "${generatedAt}",`,
    '  modes = {',
    '    mplus = { minimumKeystoneLevel = 15, dungeons = { { id = 10658, name = "Pit of Saron" } } },',
    '    raid = { bosses = { { id = 3176, name = "Test Boss" } } }',
    '  },',
    '  counts = { specs = 1, attempted = 2, recommendations = 2, specsWithAnyRecommendation = 1, skipped = 0 },',
    `  recommendations = { [62] = { mplus = { encounters = { [10658] = { importString = "${importString}" } } }, raid = { encounters = { [3176] = { importString = "RAID" } } } } },`,
    '  skipped = {}',
    '}',
    ''
  ].join('\n');
}

test('download-addon-data rejects non-addon Lua content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');

  const result = spawnSync(process.execPath, [SCRIPT, '--url', 'data:text/plain,not-addon-data', '--output', output], {
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /QuickWoWTalentsData Lua assignment/);
});

test('download-addon-data rejects incomplete addon recommendation coverage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');
  const lua = [
    'QuickWoWTalentsData = {',
    '  schemaVersion = 2,',
    '  modes = {',
    '    mplus = { minimumKeystoneLevel = 15, dungeons = { { id = 10658, name = "Pit of Saron" } } },',
    '    raid = { bosses = { { id = 3176, name = "Test Boss" } } }',
    '  },',
    '  counts = { specs = 1, attempted = 2, recommendations = 1, specsWithAnyRecommendation = 1, skipped = 1 },',
    '  recommendations = { [62] = { mplus = { encounters = { [10658] = { importString = "MPLUS" } } }, raid = { encounters = {} } } },',
    '  skipped = { { reason = "missing import string" } }',
    '}',
    ''
  ].join('\n');
  const url = `data:text/plain,${encodeURIComponent(lua)}`;

  const result = spawnSync(process.execPath, [SCRIPT, '--url', url, '--output', output], {
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Addon data is incomplete/);
});

test('download-addon-data rejects missing import strings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');
  const lua = [
    'QuickWoWTalentsData = {',
    '  schemaVersion = 2,',
    '  modes = {',
    '    mplus = { minimumKeystoneLevel = 15, dungeons = { { id = 10658, name = "Pit of Saron" } } },',
    '    raid = { bosses = { { id = 3176, name = "Test Boss" } } }',
    '  },',
    '  counts = { specs = 1, attempted = 2, recommendations = 2, specsWithAnyRecommendation = 1, skipped = 0 },',
    '  recommendations = { [62] = { mplus = { encounters = { [10658] = { importString = "" } } }, raid = { encounters = { [3176] = { importString = "RAID" } } } } },',
    '  skipped = {}',
    '}',
    ''
  ].join('\n');
  const url = `data:text/plain,${encodeURIComponent(lua)}`;

  const result = spawnSync(process.execPath, [SCRIPT, '--url', url, '--output', output], {
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing valid import strings/);
});

test('addon data comparison ignores timestamp-only changes', () => {
  const first = validAddonLua();
  const second = validAddonLua({ generatedAt: '2026-05-02T00:00:00.000Z' });
  const changedRecommendation = validAddonLua({ importString: 'DIFFERENT' });

  assert.equal(normalizeAddonDataForComparison(first), normalizeAddonDataForComparison(second));
  assert.equal(addonDataHash(first), addonDataHash(second));
  assert.notEqual(addonDataHash(first), addonDataHash(changedRecommendation));
});

test('download-addon-data does not rewrite timestamp-only changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');
  const lua = validAddonLua();
  const nextLua = validAddonLua({ generatedAt: '2026-05-02T00:00:00.000Z' });

  let url = `data:text/plain,${encodeURIComponent(lua)}`;
  let result = spawnSync(process.execPath, [SCRIPT, '--url', url, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"changed": true/);

  url = `data:text/plain,${encodeURIComponent(nextLua)}`;
  result = spawnSync(process.execPath, [SCRIPT, '--url', url, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"changed": false/);
  assert.equal(await fs.readFile(output, 'utf8'), lua);
});

test('download-addon-data writes valid addon Lua content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');
  const lua = validAddonLua();
  const url = `data:text/plain,${encodeURIComponent(lua)}`;

  const result = spawnSync(process.execPath, [SCRIPT, '--url', url, '--output', output], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), lua);
  assert.match(result.stdout, /"recommendations": 2/);
});

test('download-addon-data only fetches the addon artifact', async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => validAddonLua()
    };
  };

  try {
    await downloadAddonData({
      url: 'https://quickwowtalents.com/api/addon-data',
      outputPath: output,
      timeoutMs: 1000
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, ['https://quickwowtalents.com/api/addon-data']);
  assert.equal(calls.some((url) => url.includes('/api/build')), false);
});
