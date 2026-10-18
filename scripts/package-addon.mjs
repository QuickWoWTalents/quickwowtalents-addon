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
export const ADDON_LOGO_FILE = 'Media/Logo.tga';
export const ADDON_ICON_TEXTURE = 'Interface\\AddOns\\QuickWoWTalents\\Media\\Logo.tga';
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

export function getAddonPackageFiles(toc) {
  const declaredLuaFiles = toc.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (declaredLuaFiles.some((fileName) => !/^[A-Za-z0-9_-]+\.lua$/.test(fileName))
    || new Set(declaredLuaFiles).size !== declaredLuaFiles.length) {
    throw new Error('Addon TOC must declare unique Lua filenames without directories.');
  }
  const icons = [...toc.matchAll(/^##\s*IconTexture:\s*(.*?)\s*$/gm)];
  if (icons.length > 1 || (icons.length === 1 && icons[0][1] !== ADDON_ICON_TEXTURE)) {
    throw new Error('Addon IconTexture must use the bundled QuickWoWTalents Media/Logo.tga.');
  }
  return [...new Set([...ADDON_FILES, ...declaredLuaFiles, ...(icons.length ? [ADDON_LOGO_FILE] : [])])];
}

async function populateStagingDir(stagingRoot, repoRoot) {
  const toc = await fs.readFile(path.join(repoRoot, 'QuickWoWTalents.toc'), 'utf8');
  const files = getAddonPackageFiles(toc);
  const addonDir = path.join(stagingRoot, ADDON_NAME);
  await fs.mkdir(addonDir, { recursive: true });

  for (const fileName of files) {
    // Only the explicitly allowed logo is nested. Do not follow a source Media
    // symlink or copy arbitrary neighbouring assets into a published addon.
    if (fileName === ADDON_LOGO_FILE) {
      const mediaStat = await fs.lstat(path.join(repoRoot, 'Media'));
      if (mediaStat.isSymbolicLink() || !mediaStat.isDirectory()) {
        throw new Error('Addon Media source must be an ordinary directory.');
      }
      await fs.mkdir(path.join(addonDir, 'Media'));
    }
    const sourceStat = await fs.lstat(path.join(repoRoot, fileName));
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`Addon package source must be an ordinary file: ${fileName}`);
    }
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
