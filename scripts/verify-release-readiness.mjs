#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yauzl from 'yauzl';

import { assertReleaseVersion } from './prepare-release.mjs';
import { loadCatalogForOptions, validateAddonContract } from './validate-addon-contract.mjs';
import { loadVerifiedReleaseInputSnapshot } from './release-input-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADDON_NAME = 'QuickWoWTalents';
const REQUIRED_RETAIL_INTERFACE = '120100';
const REQUIRED_ZIP_FILES = [
  `${ADDON_NAME}/QuickWoWTalents.toc`,
  `${ADDON_NAME}/QuickWoWTalents.lua`,
  `${ADDON_NAME}/QuickWoWTalentsData.lua`,
];
const OPTIONAL_ZIP_DIRECTORY = `${ADDON_NAME}/`;
const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ARCHIVE_BYTES = 64 * 1024 * 1024;

export class AddonArchiveValidationError extends Error {}

function fail(message) {
  throw new AddonArchiveValidationError(message);
}

function readCliPath(args, env, flag, environmentName) {
  const indexes = args
    .map((argument, index) => (argument === flag ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length > 1) fail(`CLI accepts at most one ${flag} argument.`);
  if (indexes.length === 1) {
    const value = args[indexes[0] + 1];
    if (!value || value.startsWith('--')) fail(`CLI requires a value for ${flag}.`);
    return value;
  }
  const fallback = env[environmentName];
  if (fallback) return fallback;
  fail(`CLI requires ${flag} <path> or ${environmentName}.`);
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

function zipEntryKind(entry) {
  const creatorSystem = entry.versionMadeBy >>> 8;
  const unixFileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
  if (unixFileType === 0o120000) return 'symlink';
  if (creatorSystem === 3) {
    if (unixFileType === 0o040000) return 'directory';
    return unixFileType === 0o100000 ? 'regular' : 'non-regular';
  }
  return entry.fileName.endsWith('/') || dosDirectory ? 'directory' : 'regular';
}

async function readZipEntry(zipFile, entry) {
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    fail(`ZIP member ${JSON.stringify(entry.fileName)} exceeds ${MAX_ZIP_ENTRY_BYTES} bytes.`);
  }
  const stream = await zipFile.openReadStreamPromise(entry);
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > MAX_ZIP_ENTRY_BYTES) {
      stream.destroy();
      fail(`ZIP member ${JSON.stringify(entry.fileName)} exceeds ${MAX_ZIP_ENTRY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function inspectZipSnapshot(zipBytes, version) {
  let zipFile;
  try {
    zipFile = await yauzl.fromBufferPromise(zipBytes, {
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch (error) {
    fail(`Could not inspect package ZIP: ${error.message ?? String(error)}`);
  }

  const entries = [];
  const capturedFiles = new Map();
  try {
    for await (const entry of zipFile.eachEntry()) {
      const kind = zipEntryKind(entry);
      if (kind === 'directory') {
        if (entry.fileName !== OPTIONAL_ZIP_DIRECTORY) {
          fail(`Package ZIP contains unexpected directory ${JSON.stringify(entry.fileName)}.`);
        }
        continue;
      }
      if (kind !== 'regular') {
        fail(`Package ZIP member ${JSON.stringify(entry.fileName)} must be a regular file, not ${kind}.`);
      }
      entries.push(entry.fileName);
      if (REQUIRED_ZIP_FILES.includes(entry.fileName)) {
        capturedFiles.set(entry.fileName, await readZipEntry(zipFile, entry));
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Package ZIP')) throw error;
    fail(`Could not inspect package ZIP: ${error.message ?? String(error)}`);
  }

  entries.sort();
  const expected = [...REQUIRED_ZIP_FILES].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    fail(`Package ZIP must contain exactly ${expected.join(', ')} as regular files; found ${JSON.stringify(entries)}.`);
  }

  const tocBytes = capturedFiles.get(`${ADDON_NAME}/QuickWoWTalents.toc`);
  const tocText = tocBytes.toString('utf8');
  const packagedVersion = extractTocVersion(tocText, 'packaged QuickWoWTalents.toc');
  if (packagedVersion !== version) {
    fail(`packaged QuickWoWTalents.toc version ${packagedVersion} does not match package.json version ${version}.`);
  }
  assertTocInterface(tocText, 'packaged QuickWoWTalents.toc');
  return capturedFiles;
}

async function readReleaseVersion(repoRoot) {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const rawVersion = String(pkg.version ?? '');
  const version = assertReleaseVersion(rawVersion);
  if (version !== rawVersion) fail('package.json version must be plain semver.');
  return version;
}

export async function verifyAddonArchiveMatchesSource({ repoRoot = REPO_ROOT, archivePath } = {}) {
  if (typeof archivePath !== 'string' || !archivePath) {
    fail('Addon archive verification requires archivePath.');
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedArchivePath = path.resolve(archivePath);
  const archiveStat = await fs.stat(resolvedArchivePath);
  if (!archiveStat.isFile() || archiveStat.size <= 0 || archiveStat.size > MAX_ZIP_ARCHIVE_BYTES) {
    fail('Addon archive must be a non-empty bounded regular file.');
  }

  const version = await readReleaseVersion(resolvedRepoRoot);
  const zipBytes = await fs.readFile(resolvedArchivePath);
  const capturedFiles = await inspectZipSnapshot(zipBytes, version);
  for (const archiveName of REQUIRED_ZIP_FILES) {
    const sourceName = archiveName.slice(`${ADDON_NAME}/`.length);
    const sourceBytes = await fs.readFile(path.join(resolvedRepoRoot, sourceName));
    if (!sourceBytes.equals(capturedFiles.get(archiveName))) {
      fail(`packaged ${sourceName} does not match source ${sourceName}.`);
    }
  }

  return {
    ok: true,
    version,
    zipSha256: createHash('sha256').update(zipBytes).digest('hex'),
    size: zipBytes.byteLength,
  };
}

function validateDataContract(label, addonBytes, options, catalog) {
  try {
    return validateAddonContract({ addonText: addonBytes.toString('utf8'), options, catalog });
  } catch (error) {
    fail(`${label} data contract failed: ${error.message ?? String(error)}`);
  }
}

function parseOptions(optionsBytes, optionsPath) {
  try {
    return JSON.parse(optionsBytes.toString('utf8'));
  } catch (error) {
    fail(`Could not parse options snapshot ${optionsPath}: ${error.message ?? String(error)}`);
  }
}

export async function verifyReleaseReadiness({
  repoRoot = REPO_ROOT,
  optionsPath,
  catalogPath,
  snapshotManifestPath,
  requireCatalogDownload = false,
  skipZip = false,
  archiveSnapshotReader = fs.readFile,
} = {}) {
  if (typeof catalogPath !== 'string' || !catalogPath) {
    fail('Release readiness requires catalogPath.');
  }
  if (typeof optionsPath !== 'string' || !optionsPath) {
    fail('Release readiness requires optionsPath.');
  }
  if (typeof snapshotManifestPath !== 'string' || !snapshotManifestPath) {
    fail('Release readiness requires snapshotManifestPath.');
  }
  const packagePath = path.join(repoRoot, 'package.json');
  const tocPath = path.join(repoRoot, 'QuickWoWTalents.toc');
  const dataPath = path.join(repoRoot, 'QuickWoWTalentsData.lua');
  const packageMetaPath = path.join(repoRoot, '.pkgmeta');
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const curseforgeChangelogPath = path.join(repoRoot, 'CURSEFORGE_CHANGELOG.md');

  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const rawVersion = String(pkg.version ?? '');
  let version;
  try {
    version = assertReleaseVersion(rawVersion);
  } catch (error) {
    fail(`package.json ${error.message}`);
  }
  if (version !== rawVersion) fail('package.json version must be plain semver.');

  const tocText = await fs.readFile(tocPath, 'utf8');
  const tocVersion = extractTocVersion(tocText, 'QuickWoWTalents.toc');
  if (tocVersion !== version) {
    fail(`package.json version ${version} does not match QuickWoWTalents.toc version ${tocVersion}.`);
  }
  assertTocInterface(tocText, 'QuickWoWTalents.toc');

  assertPkgmetaScopedChangelog(await fs.readFile(packageMetaPath, 'utf8'));
  assertScopedCurseforgeChangelog(await fs.readFile(curseforgeChangelogPath, 'utf8'), version);
  assertHistoricalChangelog(await fs.readFile(changelogPath, 'utf8'), version);

  const {
    addonBytes: sourceDataBytes,
    optionsBytes,
    catalogBytes,
  } = await loadVerifiedReleaseInputSnapshot({
    manifestPath: snapshotManifestPath,
    addonPath: dataPath,
    optionsPath,
    catalogPath,
  });
  const options = parseOptions(optionsBytes, optionsPath);
  const catalog = await loadCatalogForOptions(catalogPath, options, {
    requireDownloadIdentity: requireCatalogDownload,
    catalogBytes,
  });
  validateDataContract('source', sourceDataBytes, options, catalog);

  const checks = [
    'package-version',
    'toc-version',
    'toc-interface',
    'pkgmeta-changelog',
    'scoped-curseforge-changelog',
    'historical-changelog',
    'release-input-snapshot',
    'source-data-contract',
  ];
  const distDir = path.resolve(repoRoot, 'dist');
  const zipPath = path.resolve(distDir, `${ADDON_NAME}-${version}.zip`);
  if (path.dirname(zipPath) !== distDir) fail('Package archive path must remain directly inside dist.');
  let zipSha256;

  if (!skipZip) {
    let snapshot;
    try {
      snapshot = await archiveSnapshotReader(zipPath);
    } catch {
      fail(`Expected package zip at ${zipPath}.`);
    }
    if (!Buffer.isBuffer(snapshot)) fail('Package archive snapshot reader must return a Buffer.');
    const zipBytes = Buffer.from(snapshot);
    zipSha256 = createHash('sha256').update(zipBytes).digest('hex');
    const zipFiles = await inspectZipSnapshot(zipBytes, version);
    const zipTocBytes = zipFiles.get(`${ADDON_NAME}/QuickWoWTalents.toc`);
    const zipAddonBytes = zipFiles.get(`${ADDON_NAME}/QuickWoWTalents.lua`);
    const zipDataBytes = zipFiles.get(`${ADDON_NAME}/QuickWoWTalentsData.lua`);
    validateDataContract('zip', zipDataBytes, options, catalog);
    if (!Buffer.from(tocText).equals(zipTocBytes)) {
      fail('packaged QuickWoWTalents.toc does not match source QuickWoWTalents.toc.');
    }
    const sourceAddonBytes = await fs.readFile(path.join(repoRoot, 'QuickWoWTalents.lua'));
    if (!sourceAddonBytes.equals(zipAddonBytes)) {
      fail('packaged QuickWoWTalents.lua does not match source QuickWoWTalents.lua.');
    }
    if (!sourceDataBytes.equals(zipDataBytes)) {
      fail('packaged QuickWoWTalentsData.lua does not match source QuickWoWTalentsData.lua.');
    }
    checks.push(
      'zip-exists',
      'zip-payload',
      'zip-toc-version',
      'zip-toc-interface',
      'zip-data-contract',
      'source-zip-toc-match',
      'source-zip-addon-match',
      'source-zip-data-match',
    );
  }

  return skipZip
    ? { ok: true, version, zipPath, checks }
    : { ok: true, version, zipPath, zipSha256, checks };
}

export function parseReadinessCli({ args = [], env = {} } = {}) {
  const requireCatalogDownloadCount = args.filter(
    (argument) => argument === '--require-catalog-download',
  ).length;
  if (requireCatalogDownloadCount > 1) {
    fail('CLI accepts at most one --require-catalog-download argument.');
  }
  return {
    optionsPath: readCliPath(args, env, '--options', 'QWT_ADDON_OPTIONS_PATH'),
    catalogPath: readCliPath(args, env, '--catalog', 'QWT_TALENT_CATALOG_PATH'),
    snapshotManifestPath: readCliPath(
      args,
      env,
      '--snapshot-manifest',
      'QWT_RELEASE_INPUT_MANIFEST_PATH',
    ),
    requireCatalogDownload: requireCatalogDownloadCount === 1,
    skipZip: args.includes('--skip-zip'),
  };
}

export async function runReadinessCli({ args = [], env = {}, repoRoot = REPO_ROOT } = {}) {
  return verifyReleaseReadiness({ repoRoot, ...parseReadinessCli({ args, env }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runReadinessCli({
      args: process.argv.slice(2),
      env: process.env,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
