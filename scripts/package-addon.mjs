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

await fs.mkdir(distDir, { recursive: true });
await fs.rm(zipPath, { force: true });
await execFileAsync('ditto', ['-c', '-k', '--keepParent', 'QuickWoWTalents', zipPath], { cwd: REPO_ROOT });

const stat = await fs.stat(zipPath);
console.log(JSON.stringify({ ok: true, zipPath, bytes: stat.size }, null, 2));
