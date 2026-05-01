#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const distDir = path.join(REPO_ROOT, 'dist');
const zipPath = path.join(distDir, `QuickWoWTalents-${pkg.version}.zip`);

async function commandExists(command) {
  try {
    await execFileAsync(command, ['--version'], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

async function createZip() {
  if (await commandExists('ditto')) {
    await execFileAsync('ditto', ['-c', '-k', '--keepParent', 'QuickWoWTalents', zipPath], { cwd: REPO_ROOT });
    return 'ditto';
  }

  if (await commandExists('zip')) {
    await execFileAsync('zip', ['-qr', zipPath, 'QuickWoWTalents'], { cwd: REPO_ROOT });
    return 'zip';
  }

  throw new Error('Could not find ditto or zip to create the addon package.');
}

await fs.mkdir(distDir, { recursive: true });
await fs.rm(zipPath, { force: true });
const packager = await createZip();

const stat = await fs.stat(zipPath);
console.log(JSON.stringify({ ok: true, zipPath, bytes: stat.size, packager }, null, 2));
