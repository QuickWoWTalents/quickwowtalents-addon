import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packageAddon } from '../scripts/package-addon.mjs';

async function writePackageFixture({ version = '1.2.3', omitFile = null } = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-package-test-'));
  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'quickwowtalents-addon', version }, null, 2)}\n`,
    'utf8',
  );
  for (const [fileName, contents] of [
    ['QuickWoWTalents.toc', '## Interface: 120100\n## Version: 1.2.3\n'],
    ['QuickWoWTalentsData.lua', 'QuickWoWTalentsData = {}\n'],
    ['QuickWoWTalents.lua', '-- addon\n'],
  ]) {
    if (fileName !== omitFile) {
      await fs.writeFile(path.join(repoRoot, fileName), contents, 'utf8');
    }
  }
  return repoRoot;
}

async function packageTempDirectories() {
  return new Set(
    (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('qwt-addon-package-')),
  );
}

function addedEntries(before, after) {
  return [...after].filter((entry) => !before.has(entry));
}

test('packageAddon rejects path-traversing versions without touching an external sentinel', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-traversal-'));
  const repoRoot = path.join(parent, 'repo');
  await fs.mkdir(repoRoot);
  const maliciousVersion = 'x/../../../outside-sentinel';
  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'quickwowtalents-addon', version: maliciousVersion }, null, 2)}\n`,
    'utf8',
  );
  const sentinelPath = path.join(parent, 'outside-sentinel.zip');
  await fs.writeFile(sentinelPath, 'do not replace\n', 'utf8');

  await assert.rejects(packageAddon({ repoRoot }), /version.*semver|plain semver/i);
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'do not replace\n');
});

for (const invalidVersion of [' 1.2.3', '01.2.3']) {
  test(`packageAddon rejects noncanonical release version ${JSON.stringify(invalidVersion)}`, async () => {
    const repoRoot = await writePackageFixture({ version: invalidVersion });
    await assert.rejects(packageAddon({ repoRoot }), /version.*plain semver|release version/i);
  });
}

test('packageAddon copy failure preserves the final archive and cleans staging', async () => {
  const repoRoot = await writePackageFixture({ omitFile: 'QuickWoWTalents.lua' });
  const distDir = path.join(repoRoot, 'dist');
  const zipPath = path.join(distDir, 'QuickWoWTalents-1.2.3.zip');
  await fs.mkdir(distDir);
  await fs.writeFile(zipPath, 'previous archive\n', 'utf8');
  const before = await packageTempDirectories();

  await assert.rejects(packageAddon({ repoRoot }), /QuickWoWTalents\.lua|ENOENT/);

  assert.equal(await fs.readFile(zipPath, 'utf8'), 'previous archive\n');
  assert.deepEqual(addedEntries(before, await packageTempDirectories()), []);
  assert.deepEqual(await fs.readdir(distDir), ['QuickWoWTalents-1.2.3.zip']);
});

test('packageAddon zip failure preserves the final archive and cleans every temporary artifact', async () => {
  const repoRoot = await writePackageFixture();
  const distDir = path.join(repoRoot, 'dist');
  const zipPath = path.join(distDir, 'QuickWoWTalents-1.2.3.zip');
  await fs.mkdir(distDir);
  await fs.writeFile(zipPath, 'previous archive\n', 'utf8');
  const before = await packageTempDirectories();

  await assert.rejects(
    packageAddon({
      repoRoot,
      async archiveWriter({ zipPath: temporaryZipPath }) {
        await fs.writeFile(temporaryZipPath, 'partial archive\n', 'utf8');
        throw new Error('simulated zip failure');
      },
    }),
    /simulated zip failure/,
  );

  assert.equal(await fs.readFile(zipPath, 'utf8'), 'previous archive\n');
  assert.deepEqual(addedEntries(before, await packageTempDirectories()), []);
  assert.deepEqual(await fs.readdir(distDir), ['QuickWoWTalents-1.2.3.zip']);
});
