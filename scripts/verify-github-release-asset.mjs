#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AddonArchiveValidationError,
  verifyAddonArchiveMatchesSource
} from './verify-release-readiness.mjs';

const MAX_RELEASE_JSON_BYTES = 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 64 * 1024 * 1024;

export function assessGithubReleaseMetadata(release, { assetName, expectedDraft = false }) {
  if (release?.isDraft !== expectedDraft || release?.isPrerelease !== false) return 'repair';
  if (typeof assetName !== 'string' || !assetName) return 'repair';
  if (!Array.isArray(release?.assets) || release.assets.length !== 1) return 'repair';
  const [asset] = release.assets;
  if (asset?.name !== assetName) return 'repair';
  if (asset.state !== 'uploaded'
    || !Number.isSafeInteger(asset.size)
    || asset.size <= 0
    || asset.size > MAX_RELEASE_ASSET_BYTES
    || !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')) {
    return 'repair';
  }
  return 'verify';
}

export async function verifyGithubReleaseAsset({
  release,
  assetName,
  archivePath,
  repoRoot,
  expectedDraft = false
}) {
  if (assessGithubReleaseMetadata(release, { assetName, expectedDraft }) !== 'verify') return false;
  const [asset] = release.assets;

  const archiveStat = await fs.stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size !== asset.size) {
    throw new Error('Downloaded asset size does not match GitHub release metadata.');
  }
  const archiveBytes = await fs.readFile(archivePath);
  const archiveDigest = createHash('sha256').update(archiveBytes).digest('hex');
  if (asset.digest !== `sha256:${archiveDigest}`) {
    throw new Error('Downloaded asset digest does not match GitHub release metadata.');
  }
  try {
    await verifyAddonArchiveMatchesSource({ repoRoot, archivePath });
    return true;
  } catch (error) {
    if (error instanceof AddonArchiveValidationError) return false;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const metadataOnly = args[0] === '--metadata';
  if (metadataOnly && args.length !== 3) {
    throw new Error('Expected release JSON path and asset name for metadata assessment.');
  }
  if (!metadataOnly && args.length !== 4) {
    throw new Error('Expected release JSON path, asset name, archive path, and repository root.');
  }
  const [releasePath, assetName, archivePath, repoRoot, ...extra] = metadataOnly
    ? args.slice(1)
    : args;
  if (!releasePath || !assetName || (!metadataOnly && (!archivePath || !repoRoot)) || extra.length > 0) {
    throw new Error('Release verification arguments must not be empty.');
  }
  const stat = await fs.stat(releasePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RELEASE_JSON_BYTES) {
    throw new Error('Release JSON must be a non-empty bounded regular file.');
  }
  const release = JSON.parse(await fs.readFile(releasePath, 'utf8'));
  console.log(metadataOnly
    ? assessGithubReleaseMetadata(release, { assetName })
    : await verifyGithubReleaseAsset({ release, assetName, archivePath, repoRoot }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('GitHub release asset verification failed.');
    process.exit(1);
  });
}
