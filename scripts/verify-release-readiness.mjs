#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADDON_NAME = 'QuickWoWTalents';
const REQUIRED_RETAIL_INTERFACE = '120007';
const REQUIRED_ZIP_FILES = [
  `${ADDON_NAME}/QuickWoWTalents.toc`,
  `${ADDON_NAME}/QuickWoWTalents.lua`,
  `${ADDON_NAME}/QuickWoWTalentsData.lua`,
];

function fail(message) {
  throw new Error(message);
}

function readFlag(flag) {
  return process.argv.includes(flag);
}

function extractTocVersion(tocText, sourceName) {
  const match = /^## Version:\s*(.+?)\s*$/m.exec(tocText);
  if (!match) fail(`Could not find ## Version in ${sourceName}.`);
  return match[1];
}

function assertTocInterface(tocText, sourceName) {
  const match = /^## Interface:\s*(.+?)\s*$/m.exec(tocText);
  if (!match) fail(`Could not find ## Interface in ${sourceName}.`);

  const interfaces = match[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!interfaces.includes(REQUIRED_RETAIL_INTERFACE)) {
    fail(`${sourceName} must include interface ${REQUIRED_RETAIL_INTERFACE}.`);
  }
}

function assertPkgmetaScopedChangelog(packageMeta) {
  if (!/manual-changelog:\n\s+filename:\s*CURSEFORGE_CHANGELOG\.md\n\s+markup-type:\s*plain/m.test(packageMeta)) {
    fail('.pkgmeta must set manual-changelog.filename to CURSEFORGE_CHANGELOG.md with markup-type plain.');
  }
}

function assertScopedCurseforgeChangelog(changelog, version) {
  const trimmed = changelog.trim();
  if (!trimmed) fail('CURSEFORGE_CHANGELOG.md must not be empty.');
  if (!new RegExp(`^QuickWoWTalents ${version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(trimmed)) {
    fail(`CURSEFORGE_CHANGELOG.md must start with QuickWoWTalents ${version} - YYYY-MM-DD.`);
  }
  if (/^#/m.test(trimmed) || /^Unreleased\b/im.test(trimmed) || new RegExp(`^QuickWoWTalents (?!${version.replaceAll('.', '\\.')}\\b)\\d+\\.\\d+\\.\\d+\\b`, 'm').test(trimmed)) {
    fail('CURSEFORGE_CHANGELOG.md must contain only the current version notes with no Markdown headings.');
  }
}

function assertHistoricalChangelog(changelog, version) {
  if (!new RegExp(`^## ${version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
    fail(`CHANGELOG.md must contain ## ${version} - YYYY-MM-DD.`);
  }
}

async function zipEntries(zipPath) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 1024 * 1024 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.endsWith('/'))
      .sort();
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    fail(`Could not inspect ${zipPath} with unzip: ${detail}`);
  }
}

async function readZipFile(zipPath, fileName) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', zipPath, fileName], { maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    fail(`Could not read ${fileName} from ${zipPath}: ${detail}`);
  }
}

async function assertZipPayload(zipPath, version) {
  const entries = await zipEntries(zipPath);
  const expected = [...REQUIRED_ZIP_FILES].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    fail(`Package zip must contain exactly ${expected.join(', ')}; found ${entries.join(', ') || 'nothing'}.`);
  }

  const tocText = await readZipFile(zipPath, `${ADDON_NAME}/QuickWoWTalents.toc`);
  const packagedVersion = extractTocVersion(tocText, 'packaged QuickWoWTalents.toc');
  if (packagedVersion !== version) {
    fail(`packaged QuickWoWTalents.toc version ${packagedVersion} does not match package.json version ${version}.`);
  }
  assertTocInterface(tocText, 'packaged QuickWoWTalents.toc');
}

export async function verifyReleaseReadiness({ repoRoot = REPO_ROOT, skipZip = false } = {}) {
  const packagePath = path.join(repoRoot, 'package.json');
  const tocPath = path.join(repoRoot, 'QuickWoWTalents.toc');
  const packageMetaPath = path.join(repoRoot, '.pkgmeta');
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const curseforgeChangelogPath = path.join(repoRoot, 'CURSEFORGE_CHANGELOG.md');

  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!version) fail('package.json must contain a version.');

  const tocText = await fs.readFile(tocPath, 'utf8');
  const tocVersion = extractTocVersion(tocText, 'QuickWoWTalents.toc');
  if (tocVersion !== version) {
    fail(`package.json version ${version} does not match QuickWoWTalents.toc version ${tocVersion}.`);
  }
  assertTocInterface(tocText, 'QuickWoWTalents.toc');

  assertPkgmetaScopedChangelog(await fs.readFile(packageMetaPath, 'utf8'));
  assertScopedCurseforgeChangelog(await fs.readFile(curseforgeChangelogPath, 'utf8'), version);
  assertHistoricalChangelog(await fs.readFile(changelogPath, 'utf8'), version);

  const checks = [
    'package-version',
    'toc-version',
    'toc-interface',
    'pkgmeta-changelog',
    'scoped-curseforge-changelog',
    'historical-changelog',
  ];
  const zipPath = path.join(repoRoot, 'dist', `${ADDON_NAME}-${version}.zip`);

  if (!skipZip) {
    await fs.access(zipPath).catch(() => fail(`Expected package zip at ${zipPath}.`));
    await assertZipPayload(zipPath, version);
    checks.push('zip-exists', 'zip-payload', 'zip-toc-version', 'zip-toc-interface');
  }

  return { ok: true, version, zipPath, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyReleaseReadiness({ skipZip: readFlag('--skip-zip') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
