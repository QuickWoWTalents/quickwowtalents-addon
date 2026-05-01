import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { addonDataHash, normalizeAddonDataForComparison } from '../scripts/download-addon-data.mjs';

const SCRIPT = new URL('../scripts/download-addon-data.mjs', import.meta.url).pathname;

test('download-addon-data rejects non-addon Lua content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');

  const result = spawnSync(process.execPath, [SCRIPT, '--url', 'data:text/plain,not-addon-data', '--output', output], {
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /QuickWoWTalentsData Lua assignment/);
});

test('addon data comparison ignores timestamp-only changes', () => {
  const first = [
    'QuickWoWTalentsData = {',
    '  schemaVersion = 2,',
    '  generatedAt = "2026-05-01T00:00:00.000Z",',
    '  counts = { recommendations = 1 },',
    '  recommendations = {}',
    '}',
    ''
  ].join('\n');
  const second = first.replace('2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z');
  const changedRecommendation = first.replace('recommendations = {}', 'recommendations = { [266] = {} }');

  assert.equal(normalizeAddonDataForComparison(first), normalizeAddonDataForComparison(second));
  assert.equal(addonDataHash(first), addonDataHash(second));
  assert.notEqual(addonDataHash(first), addonDataHash(changedRecommendation));
});

test('download-addon-data does not rewrite timestamp-only changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-download-'));
  const output = path.join(dir, 'QuickWoWTalentsData.lua');
  const lua = [
    'QuickWoWTalentsData = {',
    '  schemaVersion = 2,',
    '  generatedAt = "2026-05-01T00:00:00.000Z",',
    '  counts = { recommendations = 1 },',
    '  recommendations = {}',
    '}',
    ''
  ].join('\n');
  const nextLua = lua.replace('2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z');

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
  const lua = [
    'QuickWoWTalentsData = {',
    '  schemaVersion = 2,',
    '  generatedAt = "2026-05-01T00:00:00.000Z",',
    '  counts = { recommendations = 1 },',
    '  recommendations = {}',
    '}',
    ''
  ].join('\n');
  const url = `data:text/plain,${encodeURIComponent(lua)}`;

  const result = spawnSync(process.execPath, [SCRIPT, '--url', url, '--output', output], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), lua);
  assert.match(result.stdout, /"recommendations": 1/);
});
