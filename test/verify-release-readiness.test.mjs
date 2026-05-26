import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { verifyReleaseReadiness } from '../scripts/verify-release-readiness.mjs';

const execFileAsync = promisify(execFile);

async function writeFixture({
  packageVersion = '1.2.3',
  tocVersion = '1.2.3',
  scopedChangelog = '### 1.2.3 - 2026-05-25\n\n- Updated bundled recommendation data from quickwowtalents.com.\n',
  packageMeta = 'manual-changelog:\n  filename: CURSEFORGE_CHANGELOG.md\n  markup-type: markdown\n',
  zipTocVersion = '1.2.3',
  includeZip = true,
} = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-readiness-'));
  await fs.mkdir(path.join(repoRoot, 'dist'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'quickwowtalents-addon', version: packageVersion }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(repoRoot, 'QuickWoWTalents.toc'), `## Interface: 120005\n## Version: ${tocVersion}\n`, 'utf8');
  await fs.writeFile(path.join(repoRoot, 'QuickWoWTalents.lua'), '-- addon\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'QuickWoWTalentsData.lua'), 'QuickWoWTalentsData = {}\n', 'utf8');
  await fs.writeFile(
    path.join(repoRoot, 'CHANGELOG.md'),
    `# QuickWoWTalents Changelog\n\n## Unreleased\n\n## ${packageVersion} - 2026-05-25\n\n- Updated bundled recommendation data from quickwowtalents.com.\n\n## 1.2.2\n\nPrevious.\n`,
    'utf8',
  );
  await fs.writeFile(path.join(repoRoot, 'CURSEFORGE_CHANGELOG.md'), scopedChangelog, 'utf8');
  await fs.writeFile(path.join(repoRoot, '.pkgmeta'), packageMeta, 'utf8');

  if (includeZip) {
    const stagingRoot = path.join(repoRoot, 'stage');
    const addonDir = path.join(stagingRoot, 'QuickWoWTalents');
    await fs.mkdir(addonDir, { recursive: true });
    await fs.writeFile(path.join(addonDir, 'QuickWoWTalents.toc'), `## Interface: 120005\n## Version: ${zipTocVersion}\n`, 'utf8');
    await fs.writeFile(path.join(addonDir, 'QuickWoWTalents.lua'), '-- addon\n', 'utf8');
    await fs.writeFile(path.join(addonDir, 'QuickWoWTalentsData.lua'), 'QuickWoWTalentsData = {}\n', 'utf8');
    await execFileAsync('zip', ['-qr', path.join(repoRoot, 'dist', `QuickWoWTalents-${packageVersion}.zip`), 'QuickWoWTalents'], {
      cwd: stagingRoot,
    });
  }

  return repoRoot;
}

test('verifyReleaseReadiness accepts a scoped ready-to-publish addon release', async () => {
  const repoRoot = await writeFixture();

  const result = await verifyReleaseReadiness({ repoRoot });

  assert.deepEqual(result, {
    ok: true,
    version: '1.2.3',
    zipPath: path.join(repoRoot, 'dist', 'QuickWoWTalents-1.2.3.zip'),
    checks: [
      'package-version',
      'toc-version',
      'pkgmeta-changelog',
      'scoped-curseforge-changelog',
      'historical-changelog',
      'zip-exists',
      'zip-payload',
      'zip-toc-version',
    ],
  });
});

test('verifyReleaseReadiness rejects package and TOC version drift', async () => {
  const repoRoot = await writeFixture({ tocVersion: '1.2.2' });

  await assert.rejects(
    verifyReleaseReadiness({ repoRoot }),
    /package\.json version 1\.2\.3 does not match QuickWoWTalents\.toc version 1\.2\.2/,
  );
});

test('verifyReleaseReadiness rejects noisy CurseForge changelogs', async () => {
  const repoRoot = await writeFixture({
    scopedChangelog: '### 1.2.3 - 2026-05-25\n\n- Current.\n\n## 1.2.2\n\n- Older release.\n',
  });

  await assert.rejects(
    verifyReleaseReadiness({ repoRoot }),
    /CURSEFORGE_CHANGELOG\.md must contain only the current version notes/,
  );
});

test('verifyReleaseReadiness rejects zipped TOC version drift', async () => {
  const repoRoot = await writeFixture({ zipTocVersion: '1.2.2' });

  await assert.rejects(
    verifyReleaseReadiness({ repoRoot }),
    /packaged QuickWoWTalents\.toc version 1\.2\.2 does not match package\.json version 1\.2\.3/,
  );
});

test('verifyReleaseReadiness can skip zip checks for dry-run validation', async () => {
  const repoRoot = await writeFixture({ includeZip: false });

  const result = await verifyReleaseReadiness({ repoRoot, skipZip: true });

  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.3');
  assert.doesNotMatch(result.checks.join(','), /zip/);
});
