import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  nextPatchVersion,
  prepareRelease,
  unreleasedChangelogSection,
  versionedChangelogEntry,
} from '../scripts/prepare-release.mjs';

test('nextPatchVersion increments the patch version', () => {
  assert.equal(nextPatchVersion('0.2.8'), '0.2.9');
  assert.equal(nextPatchVersion('v1.4.99'), '1.4.100');
});

test('nextPatchVersion promotes a prerelease to its stable version', () => {
  assert.equal(nextPatchVersion('1.0.5-beta.2'), '1.0.5');
});

test('prepareRelease updates package.json and TOC version together', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-release-'));
  const packagePath = path.join(tmp, 'package.json');
  const tocPath = path.join(tmp, 'QuickWoWTalents.toc');
  const changelogPath = path.join(tmp, 'CHANGELOG.md');

  await fs.writeFile(packagePath, `${JSON.stringify({ name: 'quickwowtalents-addon', version: '0.2.8' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(tocPath, '## Title: Quick WoW Talents\n## Version: 0.2.8\nQuickWoWTalents.lua\n', 'utf8');
  await fs.writeFile(changelogPath, '# Changelog\n\n## Unreleased\n\n- Added a test feature.\n\n## 0.2.8\n\nPrevious release.\n', 'utf8');

  const result = await prepareRelease({ packagePath, tocPath, changelogPath, repoRoot: tmp, version: '0.3.0' });
  const updatedPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const updatedToc = await fs.readFile(tocPath, 'utf8');
  const updatedChangelog = await fs.readFile(changelogPath, 'utf8');

  assert.deepEqual(result, { previousVersion: '0.2.8', nextVersion: '0.3.0', previousTag: null });
  assert.equal(updatedPackage.version, '0.3.0');
  assert.match(updatedToc, /^## Version: 0\.3\.0$/m);
  assert.match(updatedChangelog, /^## 0\.3\.0 - \d{4}-\d{2}-\d{2}$/m);
  assert.match(updatedChangelog, /- Updated bundled recommendation data from quickwowtalents\.com\./);
  assert.match(updatedChangelog, /- Added a test feature\./);
});

test('prepareRelease accepts a prerelease package version when cutting stable', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-release-'));
  const packagePath = path.join(tmp, 'package.json');
  const tocPath = path.join(tmp, 'QuickWoWTalents.toc');
  const changelogPath = path.join(tmp, 'CHANGELOG.md');

  await fs.writeFile(packagePath, `${JSON.stringify({ name: 'quickwowtalents-addon', version: '1.0.5-beta.2' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(tocPath, '## Title: Quick WoW Talents\n## Version: 1.0.5-beta.2\nQuickWoWTalents.lua\n', 'utf8');
  await fs.writeFile(changelogPath, '# Changelog\n\n## Unreleased\n\n## 1.0.4\n\nPrevious release.\n', 'utf8');

  const result = await prepareRelease({ packagePath, tocPath, changelogPath, repoRoot: tmp });
  const updatedPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const updatedToc = await fs.readFile(tocPath, 'utf8');
  const updatedChangelog = await fs.readFile(changelogPath, 'utf8');

  assert.deepEqual(result, { previousVersion: '1.0.5-beta.2', nextVersion: '1.0.5', previousTag: null });
  assert.equal(updatedPackage.version, '1.0.5');
  assert.match(updatedToc, /^## Version: 1\.0\.5$/m);
  assert.match(updatedChangelog, /^## 1\.0\.5 - \d{4}-\d{2}-\d{2}$/m);
});

test('unreleasedChangelogSection extracts pending release notes', () => {
  const changelog = '# Changelog\n\n## Unreleased\n\n- First change.\n- Second change.\n\n## 1.0.0\n\nOld release.\n';

  assert.equal(unreleasedChangelogSection(changelog), '- First change.\n- Second change.');
});

test('versionedChangelogEntry includes version, data refresh, unreleased notes, and commit subjects', () => {
  const entry = versionedChangelogEntry({
    version: '1.0.8',
    date: '2026-05-06',
    previousTag: 'v1.0.7',
    unreleased: '- Added auto-open.',
    commitSubjects: ['Add Mythic+ auto-open support'],
  });

  assert.match(entry, /^## 1\.0\.8 - 2026-05-06$/m);
  assert.match(entry, /- Updated bundled recommendation data from quickwowtalents\.com\./);
  assert.match(entry, /- Added auto-open\./);
  assert.match(entry, /^### Changes since v1\.0\.7$/m);
  assert.match(entry, /- Add Mythic\+ auto-open support/);
});
