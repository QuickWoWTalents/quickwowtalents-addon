#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const TOC_FILE = path.join(REPO_ROOT, 'QuickWoWTalents.toc');
const CHANGELOG_FILE = path.join(REPO_ROOT, 'CHANGELOG.md');
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_WITH_PRERELEASE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const execFileAsync = promisify(execFile);

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

async function git(repoRoot, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function latestReleaseTag(repoRoot = REPO_ROOT) {
  try {
    return await git(repoRoot, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  } catch {
    return null;
  }
}

export async function commitSubjectsSinceTag(repoRoot = REPO_ROOT, tag = null) {
  try {
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const output = await git(repoRoot, ['log', range, '--pretty=format:%s', '--no-merges']);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^Daily addon data release v\d+\.\d+\.\d+$/i.test(line));
  } catch {
    return [];
  }
}

function unreleasedChangelogBounds(changelog) {
  const raw = String(changelog ?? '');
  const header = /^## Unreleased[ \t]*\r?\n/m.exec(raw);
  if (!header) return null;
  const bodyStart = header.index + header[0].length;
  const nextHeaderOffset = raw.slice(bodyStart).search(/\r?\n## /);
  const bodyEnd = nextHeaderOffset === -1 ? raw.length : bodyStart + nextHeaderOffset;
  return { headerStart: header.index, bodyStart, bodyEnd };
}

export function unreleasedChangelogSection(changelog) {
  const raw = String(changelog ?? '');
  const bounds = unreleasedChangelogBounds(raw);
  return bounds ? raw.slice(bounds.bodyStart, bounds.bodyEnd).trim() : '';
}

export function versionedChangelogEntry({ version, date, previousTag = null, unreleased = '', commitSubjects = [] }) {
  const lines = [`## ${assertReleaseVersion(version)} - ${date}`, ''];
  lines.push('- Updated bundled recommendation data from quickwowtalents.com.');

  if (unreleased.trim()) {
    lines.push('', unreleased.trim());
  }

  if (commitSubjects.length > 0) {
    lines.push('', `### Changes since ${previousTag ?? 'the previous release'}`);
    for (const subject of commitSubjects) {
      lines.push(`- ${subject}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function prepareChangelog({
  changelogPath = CHANGELOG_FILE,
  repoRoot = REPO_ROOT,
  nextVersion,
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const normalized = assertReleaseVersion(nextVersion);
  const raw = await fs.readFile(changelogPath, 'utf8');
  const previousTag = await latestReleaseTag(repoRoot);
  const commitSubjects = await commitSubjectsSinceTag(repoRoot, previousTag);
  const unreleased = unreleasedChangelogSection(raw);
  const entry = versionedChangelogEntry({ version: normalized, date, previousTag, unreleased, commitSubjects });
  const bounds = unreleasedChangelogBounds(raw);

  if (!bounds) {
    throw new Error(`Could not find an ## Unreleased section in ${changelogPath}`);
  }

  const next = `${raw.slice(0, bounds.bodyStart)}\n${entry}\n${raw.slice(bounds.bodyEnd).replace(/^\r?\n?/, '')}`;

  await fs.writeFile(changelogPath, next, 'utf8');
  return { previousTag, commitSubjects, nextVersion: normalized };
}

export async function prepareRelease({
  packagePath = PACKAGE_JSON,
  tocPath = TOC_FILE,
  changelogPath = CHANGELOG_FILE,
  repoRoot = REPO_ROOT,
  version = null,
} = {}) {
  const rawPkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const nextVersion = assertReleaseVersion(version ?? nextPatchVersion(rawPkg.version));
  const packageResult = await preparePackageJson(packagePath, nextVersion);
  await prepareTocVersion(tocPath, nextVersion);
  const changelogResult = await prepareChangelog({ changelogPath, repoRoot, nextVersion });
  return { ...packageResult, previousTag: changelogResult.previousTag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await prepareRelease({ version: readArg('--version', process.env.QWT_ADDON_RELEASE_VERSION || null) });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
