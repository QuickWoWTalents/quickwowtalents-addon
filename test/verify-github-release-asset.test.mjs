#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessGithubReleaseMetadata,
  verifyGithubReleaseAsset
} from '../scripts/verify-github-release-asset.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/verify-github-release-asset.mjs', import.meta.url));
const ASSET_NAME = 'QuickWoWTalents-1.2.3.zip';

async function createFixture() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-release-asset-'));
  const stagingRoot = path.join(repoRoot, 'stage');
  const addonDir = path.join(stagingRoot, 'QuickWoWTalents');
  const distDir = path.join(repoRoot, 'dist');
  await fs.mkdir(addonDir, { recursive: true });
  await fs.mkdir(distDir);
  const toc = '## Interface: 120100\n## Version: 1.2.3\nQuickWoWTalents.lua\nQuickWoWTalentsData.lua\n';
  const addon = 'QuickWoWTalents = {}\n';
  const data = 'QuickWoWTalentsData = {}\n';
  await Promise.all([
    fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8'),
    fs.writeFile(path.join(repoRoot, 'QuickWoWTalents.toc'), toc, 'utf8'),
    fs.writeFile(path.join(repoRoot, 'QuickWoWTalents.lua'), addon, 'utf8'),
    fs.writeFile(path.join(repoRoot, 'QuickWoWTalentsData.lua'), data, 'utf8'),
    fs.writeFile(path.join(addonDir, 'QuickWoWTalents.toc'), toc, 'utf8'),
    fs.writeFile(path.join(addonDir, 'QuickWoWTalents.lua'), addon, 'utf8'),
    fs.writeFile(path.join(addonDir, 'QuickWoWTalentsData.lua'), data, 'utf8')
  ]);
  const zipPath = path.join(distDir, ASSET_NAME);
  await execFileAsync('zip', ['-qr', zipPath, 'QuickWoWTalents'], { cwd: stagingRoot });
  const bytes = await fs.readFile(zipPath);
  const release = {
    isDraft: false,
    isPrerelease: false,
    assets: [{
      name: ASSET_NAME,
      state: 'uploaded',
      size: bytes.byteLength,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    }]
  };
  return { repoRoot, release, zipPath };
}

test('release verification requires exact public metadata and semantic addon contents', async () => {
  const fixture = await createFixture();
  try {
    const args = { assetName: ASSET_NAME, archivePath: fixture.zipPath, repoRoot: fixture.repoRoot };
    assert.equal(await verifyGithubReleaseAsset({ release: fixture.release, ...args }), true);

    for (const release of [
      { ...fixture.release, isDraft: true },
      { ...fixture.release, isPrerelease: true },
      { ...fixture.release, assets: [{ ...fixture.release.assets[0], state: 'new' }] },
      { ...fixture.release, assets: [{ ...fixture.release.assets[0], size: 0 }] },
      { ...fixture.release, assets: [{ ...fixture.release.assets[0], name: 'wrong.zip' }] },
      { ...fixture.release, assets: [
        fixture.release.assets[0],
        { ...fixture.release.assets[0], name: 'unexpected.zip' }
      ] },
      { ...fixture.release, assets: [...fixture.release.assets, fixture.release.assets[0]] }
    ]) {
      assert.equal(assessGithubReleaseMetadata(release, { assetName: ASSET_NAME }), 'repair');
      assert.equal(await verifyGithubReleaseAsset({ release, ...args }), false);
    }

    const inconsistentDigest = {
      ...fixture.release,
      assets: [{ ...fixture.release.assets[0], digest: `sha256:${'b'.repeat(64)}` }]
    };
    assert.equal(assessGithubReleaseMetadata(inconsistentDigest, { assetName: ASSET_NAME }), 'verify');
    await assert.rejects(
      verifyGithubReleaseAsset({ release: inconsistentDigest, ...args }),
      /does not match GitHub release metadata/
    );

    const inconsistentSize = {
      ...fixture.release,
      assets: [{ ...fixture.release.assets[0], size: fixture.release.assets[0].size + 1 }]
    };
    await assert.rejects(
      verifyGithubReleaseAsset({ release: inconsistentSize, ...args }),
      /does not match GitHub release metadata/
    );

    await fs.writeFile(path.join(fixture.repoRoot, 'QuickWoWTalents.lua'), 'QuickWoWTalents = { changed = true }\n', 'utf8');
    assert.equal(await verifyGithubReleaseAsset({ release: fixture.release, ...args }), false);
  } finally {
    await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('release verification accepts an intentionally draft release only when draft verification is requested', async () => {
  const fixture = await createFixture();
  try {
    const draft = { ...fixture.release, isDraft: true };
    const args = {
      assetName: ASSET_NAME,
      archivePath: fixture.zipPath,
      repoRoot: fixture.repoRoot,
      expectedDraft: true
    };
    assert.equal(assessGithubReleaseMetadata(draft, {
      assetName: ASSET_NAME,
      expectedDraft: true
    }), 'verify');
    assert.equal(await verifyGithubReleaseAsset({ release: draft, ...args }), true);
    assert.equal(await verifyGithubReleaseAsset({ release: fixture.release, ...args }), false);
    assert.equal(await verifyGithubReleaseAsset({
      release: { ...draft, isPrerelease: true },
      ...args
    }), false);
  } finally {
    await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('release verification CLI returns only the boolean contract', async () => {
  const fixture = await createFixture();
  try {
    const releasePath = path.join(fixture.repoRoot, 'release.json');
    await fs.writeFile(releasePath, JSON.stringify(fixture.release), 'utf8');
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      SCRIPT, releasePath, ASSET_NAME, fixture.zipPath, fixture.repoRoot
    ], { encoding: 'utf8' });
    assert.equal(stdout, 'true\n');
    assert.equal(stderr, '');

    const metadata = await execFileAsync(process.execPath, [
      SCRIPT, '--metadata', releasePath, ASSET_NAME
    ], { encoding: 'utf8' });
    assert.equal(metadata.stdout, 'verify\n');
    assert.equal(metadata.stderr, '');
  } finally {
    await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
