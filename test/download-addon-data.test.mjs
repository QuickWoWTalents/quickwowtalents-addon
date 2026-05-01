import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

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
