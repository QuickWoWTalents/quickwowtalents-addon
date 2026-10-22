#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { assessGithubReleaseMetadata, verifyGithubReleaseAsset } from './verify-github-release-asset.mjs';
import { createPublicationLedger } from './curseforge-publication-ledger.mjs';
import { prepareCurseForgeUpload, uploadCurseForge } from './curseforge-upload.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'QuickWoWTalents/quickwowtalents-addon';
const PROJECT_ID = 1530765;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
// These versions already went through the old packager. Never upload them again.
const MIGRATION_FLOOR = [1n, 0n, 155n];

function fail(message) { throw new Error(`CurseForge handoff: ${message}`); }

export function isLegacyPackagerTag(tag) {
  const match = typeof tag === 'string' && TAG.exec(tag);
  if (!match || tag.length > 64) fail('invalid release tag.');
  const version = match.slice(1).map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== MIGRATION_FLOOR[index]) return version[index] < MIGRATION_FLOOR[index];
  }
  return true;
}

async function command(program, args, cwd) {
  try {
    return (await execFileAsync(program, args, {
      cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000,
    })).stdout;
  } catch { fail(`${program} verification command failed.`); }
}

// This reads the actual published asset and an isolated checkout of its remote tag.
// It never uses the possibly refreshed working-tree data as upload input.
export async function loadVerifiedPublishedArtifact({ tag, repoRoot = process.cwd(), commandImpl = command }) {
  isLegacyPackagerTag(tag);
  const origin = (await commandImpl('git', ['remote', 'get-url', 'origin'], repoRoot)).trim();
  if (![
    `https://github.com/${REPOSITORY}.git`, `https://github.com/${REPOSITORY}`,
    `git@github.com:${REPOSITORY}.git`,
  ].includes(origin)) fail('repository origin is not canonical.');
  const records = (await commandImpl('git', [
    'ls-remote', '--refs', 'origin', 'refs/heads/main', `refs/tags/${tag}`,
  ], repoRoot)).trim().split('\n').map((line) => line.split(/\s+/));
  if (records.length !== 2 || records.some((entry) => entry.length !== 2 || !SHA.test(entry[0]))) {
    fail('fresh main and tag refs could not be verified.');
  }
  const refs = new Map(records.map(([sha, ref]) => [ref, sha]));
  const sourceCommit = refs.get(`refs/tags/${tag}`);
  const mainCommit = refs.get('refs/heads/main');
  if (!sourceCommit || !mainCommit) fail('unexpected remote refs.');
  await commandImpl('git', [
    'fetch', '--no-tags', 'origin',
    'refs/heads/main:refs/remotes/origin/main', `refs/tags/${tag}:refs/tags/${tag}`,
  ], repoRoot);
  const localTag = (await commandImpl('git', ['rev-parse', `refs/tags/${tag}^{commit}`], repoRoot)).trim();
  if (localTag !== sourceCommit) fail('tag changed during verification.');
  await commandImpl('git', ['merge-base', '--is-ancestor', sourceCommit, mainCommit], repoRoot);

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-curseforge-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  let added = false;
  try {
    await commandImpl('git', ['worktree', 'add', '--detach', sourceRoot, sourceCommit], repoRoot);
    added = true;
    const packageMetadata = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
    if (packageMetadata.version !== tag.slice(1)) fail('tag does not match the source package version.');
    const metadata = JSON.parse(await commandImpl('gh', [
      'release', 'view', tag, '--repo', REPOSITORY,
      '--json', 'assets,isDraft,isPrerelease,tagName,publishedAt',
    ], repoRoot));
    if (metadata.tagName !== tag || !Number.isFinite(Date.parse(metadata.publishedAt))) {
      fail('expected a published release for the exact tag.');
    }
    const assetName = `QuickWoWTalents-${tag.slice(1)}.zip`;
    if (assessGithubReleaseMetadata(metadata, { assetName }) !== 'verify') {
      fail('published archive metadata is invalid.');
    }
    const archivePath = path.join(temporaryRoot, assetName);
    await commandImpl('gh', [
      'release', 'download', tag, '--repo', REPOSITORY,
      '--pattern', assetName, '--dir', temporaryRoot,
    ], repoRoot);
    const stat = await fs.lstat(archivePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES) fail('invalid archive size.');
    if (!await verifyGithubReleaseAsset({
      release: metadata, assetName, archivePath, repoRoot: sourceRoot,
    })) fail('published archive does not match its tagged source.');
    const archiveBytes = await fs.readFile(archivePath);
    const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    if (archiveBytes.length !== metadata.assets[0].size
        || `sha256:${archiveSha256}` !== metadata.assets[0].digest) {
      fail('archive bytes changed after verification.');
    }
    const tocText = await fs.readFile(path.join(sourceRoot, 'QuickWoWTalents.toc'), 'utf8');
    const changelog = await fs.readFile(path.join(sourceRoot, 'CURSEFORGE_CHANGELOG.md'), 'utf8');
    // Bound TOCTOU after downloading and before any durable claim or POST.
    const finalRef = (await commandImpl('git', ['ls-remote', '--refs', 'origin', `refs/tags/${tag}`], repoRoot)).trim();
    if (finalRef !== `${sourceCommit}\trefs/tags/${tag}`) fail('release tag changed during verification.');
    return { tag, sourceCommit, archiveSha256, archiveBytes, tocText, changelog };
  } finally {
    if (added) await commandImpl('git', ['worktree', 'remove', sourceRoot], repoRoot);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertArtifact(artifact, tag) {
  if (artifact?.tag !== tag || !SHA.test(artifact.sourceCommit ?? '')
      || !DIGEST.test(artifact.archiveSha256 ?? '') || !Buffer.isBuffer(artifact.archiveBytes)
      || artifact.archiveBytes.length === 0 || artifact.archiveBytes.length > MAX_ARCHIVE_BYTES
      || createHash('sha256').update(artifact.archiveBytes).digest('hex') !== artifact.archiveSha256) {
    fail('verified artifact identity is invalid.');
  }
}

function assertSameRelease(record, artifact) {
  if (record.tag !== artifact.tag || record.sourceCommit !== artifact.sourceCommit
      || record.archiveSha256 !== artifact.archiveSha256 || record.projectId !== PROJECT_ID) {
    fail('recorded version has different source or archive bytes; refusing another upload.');
  }
}

export async function publishCurseForge({
  tag,
  checkOnly = false,
  enabled = process.env.QWT_CURSEFORGE_HANDOFF_ENABLED,
  token = process.env.CURSEFORGE_API_TOKEN,
  ledger = createPublicationLedger({ token: process.env.GH_TOKEN }),
  loadArtifact = loadVerifiedPublishedArtifact,
  prepareUpload = prepareCurseForgeUpload,
  upload = uploadCurseForge,
  now = () => new Date().toISOString(),
  uuid = randomUUID,
}) {
  const legacy = isLegacyPackagerTag(tag);
  if (typeof checkOnly !== 'boolean') fail('invalid check-only mode.');
  if (!checkOnly && enabled !== 'true') fail('direct upload cutover is not enabled.');
  if (typeof token !== 'string' || !token.trim()) fail('upload credential is unavailable.');
  const artifact = await loadArtifact({ tag });
  assertArtifact(artifact, tag);
  const existing = await ledger.read(tag);
  if (existing) {
    assertSameRelease(existing.record, artifact);
    if (existing.record.status === 'published') {
      return { ok: true, action: 'already-published', tag, fileId: existing.record.fileId };
    }
    fail('an upload was already reserved; reconcile its outcome before any further action.');
  }
  const prepared = await prepareUpload({
    tag, tocText: artifact.tocText, changelog: artifact.changelog,
    archiveBytes: artifact.archiveBytes, expectedSha256: artifact.archiveSha256, token,
  });
  if (legacy || checkOnly) {
    return { ok: true, action: legacy ? 'legacy-version-no-upload' : 'checked', tag,
      sourceCommit: artifact.sourceCommit, archiveSha256: artifact.archiveSha256 };
  }
  const record = {
    schema: 1, status: 'reserved', tag, sourceCommit: artifact.sourceCommit,
    archiveSha256: artifact.archiveSha256, projectId: PROJECT_ID,
    reservationId: uuid(), createdAt: now(),
  };
  // The durable, create-only claim must succeed unambiguously before POST.
  // A reserved receipt is deliberately never retried, even after a process crash.
  const claim = await ledger.claim(record);
  const { fileId } = await upload({ prepared, token });
  if (!Number.isSafeInteger(fileId) || fileId <= 0) fail('upload outcome is uncertain; reservation retained.');
  try {
    await ledger.complete(claim, { ...record, status: 'published', fileId, publishedAt: now() });
  } catch {
    fail(`file ${fileId} was accepted but receipt persistence failed; reservation retained. Do not upload again.`);
  }
  return { ok: true, action: 'uploaded', tag, fileId };
}

export function parseCurseForgeArgs(args) {
  const checkOnly = args[0] === '--check';
  const rest = checkOnly ? args.slice(1) : args;
  if (rest.length !== 2 || rest[0] !== '--tag') fail('expected [--check] --tag vX.Y.Z.');
  isLegacyPackagerTag(rest[1]);
  return { tag: rest[1], checkOnly };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => publishCurseForge(parseCurseForgeArgs(process.argv.slice(2))))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      // Dependencies expose sanitized fixed errors; never print causes or HTTP bodies.
      console.error(error?.message?.startsWith('CurseForge handoff:')
        ? error.message : 'CurseForge handoff failed; inspect the durable receipt before retrying.');
      process.exitCode = 1;
    });
}
