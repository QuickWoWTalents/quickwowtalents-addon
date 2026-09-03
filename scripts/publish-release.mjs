#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  assessGithubReleaseMetadata,
  verifyGithubReleaseAsset,
} from './verify-github-release-asset.mjs';
import { verifyAddonArchiveMatchesSource } from './verify-release-readiness.mjs';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_NOTES_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_ASSET_COUNT = 100;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MODES = new Set(['publish', 'reconcile']);

class PublicationError extends Error {}

function fail(message) {
  throw new PublicationError(message);
}

async function runCommand(command, args, { cwd, allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (allowFailure && Number.isInteger(error?.code)) {
      return {
        code: error.code,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : '',
      };
    }
    fail(`${command} command failed.`);
  }
}

function parseCli(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--') || values.has(flag)) {
      fail('Release publication arguments are invalid.');
    }
    values.set(flag, value);
  }
  const expectedFlags = [
    '--mode',
    '--tag',
    '--archive',
    '--expected-sha256',
    '--notes-file',
    '--source-commit',
  ];
  if (args.length !== expectedFlags.length * 2
      || [...values.keys()].some((flag) => !expectedFlags.includes(flag))) {
    fail('Release publication requires exactly the documented arguments.');
  }
  const result = Object.fromEntries(expectedFlags.map((flag) => [
    flag.slice(2).replaceAll('-', '_'),
    values.get(flag),
  ]));
  if (!MODES.has(result.mode)) fail('Release publication mode is invalid.');
  const tagMatch = RELEASE_TAG_RE.exec(result.tag);
  if (!tagMatch) fail('Release tag must be v followed by plain semver.');
  if (!/^[0-9a-f]{64}$/.test(result.expected_sha256)) {
    fail('Expected SHA-256 must be 64 lowercase hexadecimal characters.');
  }
  if (!OBJECT_ID_RE.test(result.source_commit)) fail('Source commit is invalid.');
  return {
    mode: result.mode,
    tag: result.tag,
    version: tagMatch.slice(1).join('.'),
    archivePath: result.archive,
    expectedSha256: result.expected_sha256,
    notesPath: result.notes_file,
    sourceCommit: result.source_commit,
  };
}

async function assertBoundedFile(filePath, { maximumBytes, label }) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    fail(`${label} is unavailable.`);
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
    fail(`${label} must be a non-empty bounded regular file.`);
  }
  return stat;
}

function parseSingleRef(stdout, expectedRef, { allowMissing = false } = {}) {
  const records = stdout.trim() ? stdout.trim().split('\n') : [];
  if (allowMissing && records.length === 0) return null;
  if (records.length !== 1) fail('Remote ref lookup returned an unexpected number of records.');
  const fields = records[0].split(/\s+/);
  if (fields.length !== 2 || fields[1] !== expectedRef || !OBJECT_ID_RE.test(fields[0])) {
    fail('Remote ref lookup returned an unexpected record.');
  }
  return fields[0];
}

async function assertRepositoryState({ mode, repoRoot, sourceCommit, tag }) {
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
  });
  if (status.stdout !== '') fail('Release repository must be clean.');

  const branch = await runCommand('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoRoot });
  if (branch.stdout.trim() !== 'refs/heads/main') fail('Release repository must be on main.');
  const head = await runCommand('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repoRoot });
  if (head.stdout.trim() !== sourceCommit) fail('Source commit does not match HEAD.');
  const localTag = await runCommand(
    'git',
    ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`],
    { cwd: repoRoot },
  );
  if (localTag.stdout.trim() !== sourceCommit) fail('Release tag does not identify the source commit.');

  const mainRef = 'refs/heads/main';
  const remoteMain = parseSingleRef((await runCommand(
    'git',
    ['ls-remote', '--refs', 'origin', mainRef],
    { cwd: repoRoot },
  )).stdout, mainRef);
  const tagRef = `refs/tags/${tag}`;
  const remoteTag = parseSingleRef((await runCommand(
    'git',
    ['ls-remote', '--refs', 'origin', tagRef],
    { cwd: repoRoot },
  )).stdout, tagRef, { allowMissing: mode === 'publish' });

  if (mode === 'publish') {
    if (remoteTag !== null) fail('Release tag already exists on the remote.');
    const ancestor = await runCommand(
      'git',
      ['merge-base', '--is-ancestor', remoteMain, sourceCommit],
      { cwd: repoRoot, allowFailure: true },
    );
    if (ancestor.code !== 0) fail('Remote main is not an ancestor of the source commit.');
  } else {
    if (remoteMain !== sourceCommit) fail('Remote main does not identify the source commit.');
    if (remoteTag !== sourceCommit) fail('Remote tag does not identify the source commit.');
  }
}

async function addTaggedWorktree({ repoRoot, sourceRoot, tag }) {
  await runCommand(
    'git',
    ['worktree', 'add', '--detach', sourceRoot, `refs/tags/${tag}`],
    { cwd: repoRoot },
  );
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: sourceRoot,
  });
  if (status.stdout !== '') fail('Tagged source worktree is not clean.');
}

async function removeTaggedWorktree({ repoRoot, sourceRoot }) {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', sourceRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
  } catch {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    try {
      await execFileAsync('git', ['worktree', 'prune'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      });
    } catch {
      // A stale local worktree record must not expose command output.
    }
  }
}

async function createValidatedArchiveSnapshot({ archivePath, destinationPath, expectedSha256 }) {
  const bytes = await fs.readFile(archivePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) fail('Release archive digest changed after readiness verification.');
  await fs.writeFile(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
  return destinationPath;
}

function assertReleaseShape(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)
      || typeof release.isDraft !== 'boolean'
      || typeof release.isPrerelease !== 'boolean'
      || !Array.isArray(release.assets)
      || release.assets.length > MAX_ASSET_COUNT) {
    fail('GitHub release metadata has an unexpected shape.');
  }
  if (release.isPrerelease) fail('Prerelease metadata is not allowed.');
  for (const asset of release.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
        || typeof asset.name !== 'string' || asset.name.length === 0
        || asset.name.length > 255 || asset.name.includes('\0')) {
      fail('GitHub release asset metadata has an unexpected shape.');
    }
  }
}

async function confirmReleaseMissing({ repoRoot, tag }) {
  const result = await runCommand('gh', [
    'api',
    `repos/{owner}/{repo}/releases/tags/${tag}`,
    '--method', 'GET',
    '--include',
  ], { cwd: repoRoot, allowFailure: true });
  const statuses = [...result.stdout.matchAll(/^HTTP\/\S+\s+(\d{3})\b/gm)]
    .map((match) => Number(match[1]));
  return result.code !== 0 && statuses.length > 0 && statuses.at(-1) === 404;
}

async function loadRelease({ repoRoot, tag }) {
  const result = await runCommand(
    'gh',
    ['release', 'view', tag, '--json', 'assets,isDraft,isPrerelease'],
    { cwd: repoRoot, allowFailure: true },
  );
  if (result.code !== 0) {
    if (await confirmReleaseMissing({ repoRoot, tag })) return null;
    fail('Could not determine whether the GitHub release exists.');
  }
  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch {
    fail('GitHub release metadata is not valid JSON.');
  }
  assertReleaseShape(release);
  return release;
}

async function downloadAndVerify({
  release,
  assetName,
  operationRoot,
  repoRoot,
  sourceRoot,
  tag,
  expectedSha256,
}) {
  const expectedDraft = release.isDraft;
  if (assessGithubReleaseMetadata(release, { assetName, expectedDraft }) !== 'verify') {
    return false;
  }
  const downloadRoot = await fs.mkdtemp(path.join(operationRoot, 'download-'));
  const downloadedArchive = path.join(downloadRoot, assetName);
  await runCommand('gh', [
    'release', 'download', tag,
    '--pattern', assetName,
    '--dir', downloadRoot,
  ], { cwd: repoRoot });
  const entries = await fs.readdir(downloadRoot);
  if (entries.length !== 1 || entries[0] !== assetName) {
    fail('Release download produced unexpected files.');
  }
  await assertBoundedFile(downloadedArchive, {
    maximumBytes: MAX_ARCHIVE_BYTES,
    label: 'Downloaded release archive',
  });
  const verified = await verifyGithubReleaseAsset({
    release,
    assetName,
    archivePath: downloadedArchive,
    repoRoot: sourceRoot,
    expectedDraft,
  });
  if (!verified) return false;
  const downloadedBytes = await fs.readFile(downloadedArchive);
  return createHash('sha256').update(downloadedBytes).digest('hex') === expectedSha256;
}

async function createDraft({ archivePath, notesPath, repoRoot, tag }) {
  await runCommand('gh', [
    'release', 'create', tag, archivePath,
    '--verify-tag',
    '--draft',
    '--title', `QuickWoWTalents ${tag}`,
    '--notes-file', notesPath,
  ], { cwd: repoRoot });
}

async function publishDraft({ repoRoot, tag }) {
  await runCommand(
    'gh',
    ['release', 'edit', tag, '--draft=false', '--prerelease=false'],
    { cwd: repoRoot },
  );
}

async function verifyDraftThenPublish(context) {
  const release = await loadRelease(context);
  if (release === null || release.isDraft !== true) fail('Expected a draft GitHub release.');
  if (!await downloadAndVerify({ ...context, release })) {
    fail('Draft release asset does not match the tagged source.');
  }
  await publishDraft(context);
}

async function publishNew(context) {
  await runCommand('gh', ['auth', 'setup-git'], { cwd: context.repoRoot });
  await runCommand('git', [
    'push', '--atomic', 'origin',
    'refs/heads/main:refs/heads/main',
    `refs/tags/${context.tag}:refs/tags/${context.tag}`,
  ], { cwd: context.repoRoot });
  await createDraft(context);
  await verifyDraftThenPublish(context);
  return { ok: true, action: 'published' };
}

async function repairRelease({ release, ...context }) {
  if (!release.isDraft) {
    await runCommand('gh', ['release', 'edit', context.tag, '--draft'], {
      cwd: context.repoRoot,
    });
  }
  for (const wrongAsset of release.assets.filter((asset) => asset.name !== context.assetName)) {
    await runCommand('gh', [
      'release', 'delete-asset', '--yes', '--', context.tag, wrongAsset.name,
    ], { cwd: context.repoRoot });
  }
  await runCommand(
    'gh',
    ['release', 'upload', context.tag, context.archivePath, '--clobber'],
    { cwd: context.repoRoot },
  );
  await verifyDraftThenPublish(context);
}

async function reconcile(context) {
  const release = await loadRelease(context);
  if (release === null) {
    await createDraft(context);
    await verifyDraftThenPublish(context);
    return { ok: true, action: 'reconciled' };
  }

  const verified = await downloadAndVerify({ ...context, release });
  if (verified) {
    if (!release.isDraft) return { ok: true, action: 'verified' };
    await publishDraft(context);
    return { ok: true, action: 'reconciled' };
  }

  await repairRelease({ ...context, release });
  return { ok: true, action: 'reconciled' };
}

export async function publishRelease({ args, repoRoot = process.cwd() }) {
  const options = parseCli(args);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const archivePath = path.resolve(resolvedRepoRoot, options.archivePath);
  const notesPath = path.resolve(resolvedRepoRoot, options.notesPath);
  if (path.basename(archivePath) !== `QuickWoWTalents-${options.version}.zip`) {
    fail('Release archive name does not match the release tag.');
  }
  await Promise.all([
    assertBoundedFile(archivePath, {
      maximumBytes: MAX_ARCHIVE_BYTES,
      label: 'Release archive',
    }),
    assertBoundedFile(notesPath, {
      maximumBytes: MAX_NOTES_BYTES,
      label: 'Release notes',
    }),
  ]);
  await assertRepositoryState({ ...options, repoRoot: resolvedRepoRoot });

  const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), `qwt-release-${options.tag}-`));
  const sourceRoot = path.join(operationRoot, 'source');
  try {
    await addTaggedWorktree({ repoRoot: resolvedRepoRoot, sourceRoot, tag: options.tag });
    await verifyAddonArchiveMatchesSource({ repoRoot: sourceRoot, archivePath });
    const validatedArchivePath = await createValidatedArchiveSnapshot({
      archivePath,
      destinationPath: path.join(operationRoot, path.basename(archivePath)),
      expectedSha256: options.expectedSha256,
    });
    const context = {
      archivePath: validatedArchivePath,
      assetName: path.basename(archivePath),
      expectedSha256: options.expectedSha256,
      notesPath,
      operationRoot,
      repoRoot: resolvedRepoRoot,
      sourceRoot,
      tag: options.tag,
    };
    const result = options.mode === 'publish'
      ? await publishNew(context)
      : await reconcile(context);
    return { ...result, tag: options.tag };
  } finally {
    await removeTaggedWorktree({ repoRoot: resolvedRepoRoot, sourceRoot });
    await fs.rm(operationRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  publishRelease({ args: process.argv.slice(2) })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('Release publication failed.');
      process.exitCode = 1;
    });
}
