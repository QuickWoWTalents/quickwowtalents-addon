#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const TOC_FILE = path.join(REPO_ROOT, 'QuickWoWTalents.toc');
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_WITH_PRERELEASE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

function readArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  const value = process.argv[index + 1];
  return value === '' ? fallback : value;
}

export function assertReleaseVersion(version) {
  const normalized = String(version ?? '').trim().replace(/^v/i, '');
  if (!SEMVER_RE.test(normalized)) {
    throw new Error(`Release version must be plain semver like 0.2.9; received ${JSON.stringify(version)}`);
  }
  return normalized;
}

export function normalizePackageVersion(version) {
  const normalized = String(version ?? '').trim().replace(/^v/i, '');
  if (!SEMVER_WITH_PRERELEASE_RE.test(normalized)) {
    throw new Error(`Package version must be semver like 0.2.9 or 0.2.9-beta.1; received ${JSON.stringify(version)}`);
  }
  return normalized;
}

export function nextPatchVersion(version) {
  const normalized = normalizePackageVersion(version);
  const [, major, minor, patch] = normalized.match(SEMVER_WITH_PRERELEASE_RE);
  if (normalized.includes('-')) {
    return `${Number(major)}.${Number(minor)}.${Number(patch)}`;
  }
  return `${Number(major)}.${Number(minor)}.${Number(patch) + 1}`;
}

export async function preparePackageJson(packagePath, nextVersion) {
  const normalized = assertReleaseVersion(nextVersion);
  const raw = await fs.readFile(packagePath, 'utf8');
  const pkg = JSON.parse(raw);
  const previousVersion = normalizePackageVersion(pkg.version);
  pkg.version = normalized;
  await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return { previousVersion, nextVersion: normalized };
}

export async function prepareTocVersion(tocPath, nextVersion) {
  const normalized = assertReleaseVersion(nextVersion);
  const raw = await fs.readFile(tocPath, 'utf8');
  const next = raw.replace(/^## Version: .+$/m, `## Version: ${normalized}`);
  if (next === raw) {
    throw new Error(`Could not find a ## Version line in ${tocPath}`);
  }
  await fs.writeFile(tocPath, next, 'utf8');
  return { nextVersion: normalized };
}

export async function prepareRelease({ packagePath = PACKAGE_JSON, tocPath = TOC_FILE, version = null } = {}) {
  const rawPkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const nextVersion = assertReleaseVersion(version ?? nextPatchVersion(rawPkg.version));
  const packageResult = await preparePackageJson(packagePath, nextVersion);
  await prepareTocVersion(tocPath, nextVersion);
  return packageResult;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await prepareRelease({ version: readArg('--version', process.env.QWT_ADDON_RELEASE_VERSION || null) });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
