#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADDON_NAME = 'QuickWoWTalents';
const ADDON_FILES = [
  'QuickWoWTalents.toc',
  'QuickWoWTalentsData.lua',
  'QuickWoWTalents.lua'
];
const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const distDir = path.join(REPO_ROOT, 'dist');
const zipPath = path.join(distDir, `${ADDON_NAME}-${pkg.version}.zip`);

async function commandExists(command) {
  try {
    await execFileAsync(command, ['--version'], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

async function createStagingDir() {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-package-'));
  const addonDir = path.join(stagingRoot, ADDON_NAME);
  await fs.mkdir(addonDir, { recursive: true });

  for (const fileName of ADDON_FILES) {
    await fs.copyFile(path.join(REPO_ROOT, fileName), path.join(addonDir, fileName));
  }

  return stagingRoot;
}

async function createZip(stagingRoot) {
  if (await commandExists('ditto')) {
    await execFileAsync('ditto', ['-c', '-k', '--keepParent', ADDON_NAME, zipPath], { cwd: stagingRoot });
    return 'ditto';
  }

  if (await commandExists('zip')) {
    await execFileAsync('zip', ['-qr', zipPath, ADDON_NAME], { cwd: stagingRoot });
    return 'zip';
  }

  throw new Error('Could not find ditto or zip to create the addon package.');
}

await fs.mkdir(distDir, { recursive: true });
await fs.rm(zipPath, { force: true });
const stagingRoot = await createStagingDir();
let packager;
try {
  packager = await createZip(stagingRoot);
} finally {
  await fs.rm(stagingRoot, { recursive: true, force: true });
}

const stat = await fs.stat(zipPath);
console.log(JSON.stringify({ ok: true, zipPath, bytes: stat.size, packager }, null, 2));
