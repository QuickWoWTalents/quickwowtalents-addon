import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadVerifiedPublishedArtifact } from '../scripts/publish-curseforge.mjs';
import { verifyGithubReleaseAsset } from '../scripts/verify-github-release-asset.mjs';

const exec = promisify(execFile);
const TAG = 'v1.0.156';
const NAME = 'QuickWoWTalents-1.0.156.zip';
const REPOSITORY = 'QuickWoWTalents/quickwowtalents-addon';
const ORIGIN = `https://github.com/${REPOSITORY}.git`;
const TOC = '## Interface: 120105, 120100, 120007, 120005, 120001, 120000, 110200\n## Version: 1.0.156\nQuickWoWTalents.lua\nQuickWoWTalentsData.lua\n';
const NOTES = 'QuickWoWTalents 1.0.156 - 2026-10-23\n\n- Refresh verified data.\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = async (cwd, args) => (await exec('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
})).stdout;

function asset(bytes) {
  return { name: NAME, state: 'uploaded', size: bytes.length, digest: `sha256:${digest(bytes)}` };
}

async function archiveCommit(fixture, commit, name = 'published.zip') {
  const archive = path.join(fixture.root, name);
  await git(fixture.work, [
    'archive', '--format=zip', '--prefix=QuickWoWTalents/', `--output=${archive}`, commit,
    'QuickWoWTalents.toc', 'QuickWoWTalents.lua', 'QuickWoWTalentsData.lua',
  ]);
  return fs.readFile(archive);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-curseforge-artifact-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const work = path.join(root, 'work');
  const remote = path.join(root, 'origin.git');
  await fs.mkdir(work);
  await git(root, ['init', '--bare', remote]);
  await git(work, ['init', '--initial-branch=main']);
  await git(work, ['config', 'user.name', 'Artifact Test']);
  await git(work, ['config', 'user.email', 'artifact@example.test']);
  await git(work, ['config', 'core.autocrlf', 'false']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  await git(work, ['config', 'tag.gpgsign', 'false']);
  await Promise.all(Object.entries({
    'package.json': JSON.stringify({ version: '1.0.156' }),
    'QuickWoWTalents.toc': TOC,
    'QuickWoWTalents.lua': 'QuickWoWTalents = {}\n',
    'QuickWoWTalentsData.lua': 'QuickWoWTalentsData = { generation = "before-release" }\n',
    'CURSEFORGE_CHANGELOG.md': NOTES,
  }).map(([name, bytes]) => fs.writeFile(path.join(work, name), bytes)));
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', 'Base source']);
  const baseCommit = (await git(work, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(work, 'QuickWoWTalentsData.lua'), 'QuickWoWTalentsData = { generation = "release" }\n');
  await git(work, ['add', 'QuickWoWTalentsData.lua']);
  await git(work, ['commit', '-m', 'Verified release source']);
  await git(work, ['tag', TAG]);
  const sourceCommit = (await git(work, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(work, 'later.txt'), 'Subsequent main change\n');
  await git(work, ['add', 'later.txt']);
  await git(work, ['commit', '-m', 'Main advances after release']);
  await git(work, ['remote', 'add', 'origin', remote]);
  await git(work, ['push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', `refs/tags/${TAG}:refs/tags/${TAG}`]);
  const result = { root, work, remote, baseCommit, sourceCommit, calls: [], origin: ORIGIN };
  result.bytes = await archiveCommit(result, sourceCommit);
  result.release = {
    tagName: TAG, publishedAt: '2026-10-23T14:48:48Z', isDraft: false, isPrerelease: false,
    assets: [asset(result.bytes)],
  };
  result.commandImpl = async (program, args, cwd) => {
    result.calls.push({ program, args: [...args], cwd });
    if (program === 'git') {
      if (args[0] === 'remote' && args[1] === 'get-url') return `${result.origin}\n`;
      if (args[0] === 'ls-remote' && args.length === 4 && result.beforeFinalRef) {
        await result.beforeFinalRef();
      }
      if (args[0] === 'worktree' && args[1] === 'remove' && result.tamperIsolatedSource) {
        // Restore our injected corruption only after verification so normal cleanup can finish.
        await git(args[2], ['restore', '--', 'QuickWoWTalents.lua']);
      }
      const stdout = await git(cwd, args);
      if (args[0] === 'worktree' && args[1] === 'add' && result.tamperIsolatedSource) {
        await fs.writeFile(path.join(args[3], 'QuickWoWTalents.lua'), 'changed after isolated checkout\n');
      }
      return stdout;
    }
    assert.equal(program, 'gh');
    assert.equal(args[0], 'release');
    assert.equal(args[2], TAG);
    assert.equal(args[args.indexOf('--repo') + 1], REPOSITORY);
    if (args[1] === 'view') return JSON.stringify(result.release);
    assert.equal(args[1], 'download', 'No GitHub mutation or other network operation is permitted.');
    assert.equal(args[args.indexOf('--pattern') + 1], NAME);
    const target = path.join(args[args.indexOf('--dir') + 1], NAME);
    await fs.writeFile(target, result.downloadBytes ?? result.bytes);
    return '';
  };
  result.load = () => loadVerifiedPublishedArtifact({ tag: TAG, repoRoot: work, commandImpl: result.commandImpl });
  return result;
}

async function assertTemporaryWorktreeRemoved(f) {
  const add = f.calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add');
  if (!add) return;
  await assert.rejects(fs.access(add.args[3]), { code: 'ENOENT' });
  const registrations = await git(f.work, ['worktree', 'list', '--porcelain']);
  assert.ok(!registrations.includes(add.args[3].replaceAll('\\', '/')));
}

test('published handoff returns exact verified release bytes from its tag, independent of changed working files', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.work, 'QuickWoWTalents.toc'), 'unrelated current working tree\n');
  await fs.writeFile(path.join(f.work, 'QuickWoWTalentsData.lua'), 'newer unpublished data\n');
  const result = await f.load();
  assert.deepEqual(result, {
    tag: TAG, sourceCommit: f.sourceCommit, archiveSha256: digest(f.bytes), archiveBytes: f.bytes,
    tocText: TOC, changelog: NOTES,
  });
  assert.ok(f.calls.some(({ args }) => args[0] === 'fetch' && args.includes('--no-tags')));
  assert.ok(f.calls.some(({ args }) => args[0] === 'merge-base' && args[1] === '--is-ancestor'));
  assert.equal(f.calls.filter(({ args }) => args[0] === 'ls-remote').length, 2);
  await assertTemporaryWorktreeRemoved(f);
});

test('noncanonical origin fails before fetching or requesting a release', async (t) => {
  const f = await fixture(t);
  for (const origin of [
    'https://github.com/example/quickwowtalents-addon.git',
    'https://github.com/QuickWoWTalents/quickwowtalents-addon.git.evil.test',
    'https://token@example.test/private.git',
  ]) {
    f.origin = origin;
    f.calls.length = 0;
    await assert.rejects(f.load(), /origin is not canonical/);
    assert.equal(f.calls.length, 1);
  }
});

test('draft, prerelease, wrong-tag and unpublished metadata cannot become an upload artifact', async (t) => {
  const f = await fixture(t);
  const valid = structuredClone(f.release);
  for (const patch of [
    { isDraft: true }, { isPrerelease: true }, { tagName: 'v1.0.157' }, { publishedAt: null },
  ]) {
    f.calls.length = 0;
    f.release = { ...structuredClone(valid), ...patch };
    await assert.rejects(f.load(), /published release|metadata is invalid/);
    assert.equal(f.calls.some(({ args }) => args[0] === 'release' && args[1] === 'download'), false);
    await assertTemporaryWorktreeRemoved(f);
  }
});

test('multiple, missing and incorrectly named GitHub assets are rejected', async (t) => {
  const f = await fixture(t);
  for (const assets of [
    [], [asset(f.bytes), { ...asset(f.bytes), name: 'extra.zip' }],
    [{ ...asset(f.bytes), name: 'incorrect.zip' }],
  ]) {
    f.calls.length = 0;
    f.release.assets = assets;
    await assert.rejects(f.load(), /metadata is invalid/);
    assert.equal(f.calls.some(({ args }) => args[0] === 'release' && args[1] === 'download'), false);
    await assertTemporaryWorktreeRemoved(f);
  }
});

test('a valid source-matching package with the wrong version for its release tag is rejected', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.work, 'package.json'), JSON.stringify({ version: '1.0.155' }));
  await fs.writeFile(path.join(f.work, 'QuickWoWTalents.toc'), TOC.replace('## Version: 1.0.156', '## Version: 1.0.155'));
  await git(f.work, ['add', 'package.json', 'QuickWoWTalents.toc']);
  await git(f.work, ['commit', '-m', 'Source and TOC agree on an incorrectly tagged package version']);
  const mistaggedCommit = (await git(f.work, ['rev-parse', 'HEAD'])).trim();
  await git(f.work, ['tag', '--force', TAG]);
  await git(f.work, ['push', 'origin', 'refs/heads/main:refs/heads/main']);
  await git(f.remote, ['update-ref', `refs/tags/${TAG}`, mistaggedCommit]);
  f.bytes = await archiveCommit(f, mistaggedCommit, 'mistagged.zip');
  f.release.assets = [asset(f.bytes)];
  assert.equal(await verifyGithubReleaseAsset({
    release: f.release, assetName: NAME, archivePath: path.join(f.root, 'mistagged.zip'), repoRoot: f.work,
  }), true, 'The ZIP genuinely matches its tagged source and digest; tag/version binding must reject it.');
  await assert.rejects(f.load(), /tag does not match the source package version/);
  assert.equal(f.calls.some(({ program }) => program === 'gh'), false);
  await assertTemporaryWorktreeRemoved(f);
});

test('downloaded ZIP digest must match GitHub metadata', async (t) => {
  const f = await fixture(t);
  f.release.assets[0].digest = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(f.load(), /digest does not match/);
  await assertTemporaryWorktreeRemoved(f);
});

test('a real ZIP with valid metadata but different source data is rejected', async (t) => {
  const f = await fixture(t);
  f.downloadBytes = await archiveCommit(f, f.baseCommit, 'different-source.zip');
  f.release.assets = [asset(f.downloadBytes)];
  await assert.rejects(f.load(), /does not match its tagged source/);
  await assertTemporaryWorktreeRemoved(f);
});

test('source outside the freshly observed remote main ancestry is rejected before GitHub access', async (t) => {
  const f = await fixture(t);
  await git(f.remote, ['update-ref', 'refs/heads/main', f.baseCommit]);
  await git(f.work, ['update-ref', 'refs/remotes/origin/main', f.baseCommit]);
  await assert.rejects(f.load());
  assert.ok(f.calls.some(({ args }) => args[0] === 'merge-base' && args[1] === '--is-ancestor'));
  assert.equal(f.calls.some(({ program }) => program === 'gh'), false);
});

test('a tag moved during download is rejected after semantic archive verification', async (t) => {
  const f = await fixture(t);
  f.beforeFinalRef = () => git(f.remote, ['update-ref', `refs/tags/${TAG}`, f.baseCommit]);
  await assert.rejects(f.load(), /tag changed during verification/);
  assert.ok(f.calls.some(({ args }) => args[0] === 'release' && args[1] === 'download'));
  await assertTemporaryWorktreeRemoved(f);
});

test('isolated tagged source modification cannot validate a different package', async (t) => {
  const f = await fixture(t);
  f.tamperIsolatedSource = true;
  await assert.rejects(f.load(), /does not match its tagged source/);
  await assertTemporaryWorktreeRemoved(f);
});
