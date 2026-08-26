#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertReleaseVersion } from './prepare-release.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADDON_NAME = 'QuickWoWTalents';
const ADDON_FILES = [
  'QuickWoWTalents.toc',
  'QuickWoWTalentsData.lua',
  'QuickWoWTalents.lua'
];

async function commandExists(command, repoRoot) {
  try {
    await execFileAsync(command, ['--version'], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function populateStagingDir(stagingRoot, repoRoot) {
  const addonDir = path.join(stagingRoot, ADDON_NAME);
  await fs.mkdir(addonDir, { recursive: true });

  for (const fileName of ADDON_FILES) {
    await fs.copyFile(path.join(repoRoot, fileName), path.join(addonDir, fileName));
  }
}

async function createZip({ stagingRoot, zipPath, repoRoot }) {
  if (await commandExists('ditto', repoRoot)) {
    await execFileAsync('ditto', ['-c', '-k', '--keepParent', ADDON_NAME, zipPath], { cwd: stagingRoot });
    return 'ditto';
  }

  if (await commandExists('zip', repoRoot)) {
    await execFileAsync('zip', ['-qr', zipPath, ADDON_NAME], { cwd: stagingRoot });
    return 'zip';
  }

  throw new Error('Could not find ditto or zip to create the addon package.');
}

export async function packageAddon({ repoRoot = REPO_ROOT, archiveWriter = createZip } = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const pkg = JSON.parse(await fs.readFile(path.join(resolvedRepoRoot, 'package.json'), 'utf8'));
  const rawVersion = String(pkg.version ?? '');
  const version = assertReleaseVersion(rawVersion);
  if (version !== rawVersion) {
    throw new Error(`Package version must be plain semver; received ${JSON.stringify(pkg.version)}`);
  }

  const distDir = path.resolve(resolvedRepoRoot, 'dist');
  const zipPath = path.resolve(distDir, `${ADDON_NAME}-${version}.zip`);
  if (path.dirname(zipPath) !== distDir) {
    throw new Error('Package archive path must remain directly inside dist.');
  }

  await fs.mkdir(distDir, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-package-'));
  try {
    await populateStagingDir(stagingRoot, resolvedRepoRoot);
    const outputRoot = await fs.mkdtemp(path.join(distDir, '.qwt-addon-output-'));
    try {
      const temporaryZipPath = path.join(outputRoot, `${ADDON_NAME}-${version}.zip`);
      const packager = await archiveWriter({
        stagingRoot,
        zipPath: temporaryZipPath,
        repoRoot: resolvedRepoRoot,
      });
      await fs.rename(temporaryZipPath, zipPath);
      const stat = await fs.stat(zipPath);
      return { ok: true, zipPath, bytes: stat.size, packager };
    } finally {
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await packageAddon(), null, 2));
}
