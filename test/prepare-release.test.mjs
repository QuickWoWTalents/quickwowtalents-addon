import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { nextPatchVersion, prepareRelease } from '../scripts/prepare-release.mjs';

test('nextPatchVersion increments the patch version', () => {
  assert.equal(nextPatchVersion('0.2.8'), '0.2.9');
  assert.equal(nextPatchVersion('v1.4.99'), '1.4.100');
});

test('prepareRelease updates package.json and TOC version together', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-release-'));
  const packagePath = path.join(tmp, 'package.json');
  const tocPath = path.join(tmp, 'QuickWoWTalents.toc');

  await fs.writeFile(packagePath, `${JSON.stringify({ name: 'quickwowtalents-addon', version: '0.2.8' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(tocPath, '## Title: Quick WoW Talents\n## Version: 0.2.8\nQuickWoWTalents.lua\n', 'utf8');

  const result = await prepareRelease({ packagePath, tocPath, version: '0.3.0' });
  const updatedPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const updatedToc = await fs.readFile(tocPath, 'utf8');

  assert.deepEqual(result, { previousVersion: '0.2.8', nextVersion: '0.3.0' });
  assert.equal(updatedPackage.version, '0.3.0');
  assert.match(updatedToc, /^## Version: 0\.3\.0$/m);
});
