#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/publish-release.mjs', import.meta.url));
const REAL_GIT = (await execFileAsync('which', ['git'], { encoding: 'utf8' })).stdout.trim();
const TAG = 'v1.2.3';
const ASSET_NAME = 'QuickWoWTalents-1.2.3.zip';

const BOUNDARY_SCRIPT = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
state.counts ??= {};
const commandKey = [tool, ...args.slice(0, 2)].join(' ');
state.counts[commandKey] = (state.counts[commandKey] ?? 0) + 1;
fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ tool, args }) + '\\n');

const failurePrefix = process.env.FAIL_COMMAND;
const failureAt = Number(process.env.FAIL_COMMAND_AT ?? '1');
if (failurePrefix && [tool, ...args].join(' ').startsWith(failurePrefix)
    && state.counts[commandKey] === failureAt) {
  process.stdout.write(process.env.FAIL_OUTPUT ?? 'boundary failed');
  process.stderr.write(process.env.FAIL_OUTPUT ?? 'boundary failed');
  process.exit(42);
}

if (tool === 'git') {
  const result = spawnSync(process.env.REAL_GIT, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

function persist() {
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
}

function assetFromFile(file) {
  const bytes = fs.readFileSync(file);
  return {
    name: path.basename(file),
    state: 'uploaded',
    size: bytes.byteLength,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    content: bytes.toString('base64'),
  };
}

if (args[0] === 'auth' && args[1] === 'setup-git') process.exit(0);

if (args[0] === 'api') {
  if (state.release === null) {
    process.stdout.write('HTTP/2.0 404 Not Found\\n');
    process.exit(1);
  }
  process.stdout.write('HTTP/2.0 200 OK\\n');
  process.exit(0);
}

if (args[0] !== 'release') process.exit(97);

if (args[1] === 'view') {
  if (state.release === null) process.exit(1);
  if (process.env.GH_VIEW_RAW) {
    process.stdout.write(process.env.GH_VIEW_RAW);
    process.exit(0);
  }
  const { isDraft, isPrerelease, assets } = state.release;
  process.stdout.write(JSON.stringify({
    isDraft,
    isPrerelease,
    assets: assets.map(({ content, ...metadata }) => metadata),
  }));
  process.exit(0);
}

if (args[1] === 'create') {
  const archivePath = args[3];
  state.release = {
    isDraft: args.includes('--draft'),
    isPrerelease: args.includes('--prerelease'),
    assets: [assetFromFile(archivePath)],
  };
  if (process.env.CORRUPT_CREATED_ASSET === 'true') {
    const bytes = Buffer.from('not a zip');
    state.release.assets[0] = {
      ...state.release.assets[0],
      size: bytes.byteLength,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      content: bytes.toString('base64'),
    };
  }
  persist();
  if (process.env.MUTATE_SOURCE_AFTER_CREATE) {
    fs.writeFileSync(process.env.MUTATE_SOURCE_AFTER_CREATE, 'changed after draft creation\\n');
  }
  process.exit(0);
}

if (args[1] === 'download') {
  if (state.release === null) process.exit(2);
  const pattern = args[args.indexOf('--pattern') + 1];
  const directory = args[args.indexOf('--dir') + 1];
  const asset = state.release.assets.find((candidate) => candidate.name === pattern);
  if (!asset) process.exit(3);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, pattern), Buffer.from(asset.content, 'base64'));
  process.exit(0);
}

if (args[1] === 'edit') {
  if (state.release === null) process.exit(4);
  if (args.includes('--draft') || args.includes('--draft=true')) state.release.isDraft = true;
  if (args.includes('--draft=false')) state.release.isDraft = false;
  if (args.includes('--prerelease=false')) state.release.isPrerelease = false;
  persist();
  process.exit(0);
}

if (args[1] === 'delete-asset') {
  const separator = args.indexOf('--');
  const releaseTagIndex = separator === -1 ? 2 : separator + 1;
  const assetName = args[releaseTagIndex + 1];
  state.release.assets = state.release.assets.filter((asset) => asset.name !== assetName);
  persist();
  process.exit(0);
}

if (args[1] === 'upload') {
  const archivePath = args[3];
  const replacement = assetFromFile(archivePath);
  state.release.assets = state.release.assets.filter((asset) => asset.name !== replacement.name);
  state.release.assets.push(replacement);
  persist();
  process.exit(0);
}

process.exit(98);
`;

async function git(cwd, args) {
  return execFileAsync(REAL_GIT, args, { cwd, encoding: 'utf8' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createFixture({ pushReleaseRefs = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt publish release-'));
  const remotePath = path.join(root, 'origin.git');
  const workPath = path.join(root, 'work');
  const stagingPath = path.join(root, 'staging', 'QuickWoWTalents');
  const artifactDir = path.join(root, 'release artifacts');
  const binDir = path.join(root, 'bin');
  const commandLog = path.join(root, 'commands.jsonl');
  const statePath = path.join(root, 'github-state.json');
  const notesPath = path.join(root, 'release notes.md');
  await Promise.all([
    fs.mkdir(workPath),
    fs.mkdir(stagingPath, { recursive: true }),
    fs.mkdir(artifactDir),
    fs.mkdir(binDir),
  ]);
  await git(root, ['init', '--bare', remotePath]);
  await git(workPath, ['init']);
  await git(workPath, ['config', 'user.name', 'Release Test']);
  await git(workPath, ['config', 'user.email', 'release@example.test']);

  const toc = '## Interface: 120100\n## Version: 1.2.3\nQuickWoWTalents.lua\nQuickWoWTalentsData.lua\n';
  const addon = 'QuickWoWTalents = {}\n';
  const data = 'QuickWoWTalentsData = {}\n';
  await Promise.all([
    fs.writeFile(path.join(workPath, '.gitignore'), '/dist/\n', 'utf8'),
    fs.writeFile(path.join(workPath, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8'),
    fs.writeFile(path.join(workPath, 'QuickWoWTalents.toc'), toc, 'utf8'),
    fs.writeFile(path.join(workPath, 'QuickWoWTalents.lua'), addon, 'utf8'),
    fs.writeFile(path.join(workPath, 'QuickWoWTalentsData.lua'), data, 'utf8'),
    fs.writeFile(path.join(stagingPath, 'QuickWoWTalents.toc'), toc, 'utf8'),
    fs.writeFile(path.join(stagingPath, 'QuickWoWTalents.lua'), addon, 'utf8'),
    fs.writeFile(path.join(stagingPath, 'QuickWoWTalentsData.lua'), data, 'utf8'),
    fs.writeFile(notesPath, 'QuickWoWTalents 1.2.3 release notes.\n', 'utf8'),
    fs.writeFile(commandLog, '', 'utf8'),
    fs.writeFile(statePath, JSON.stringify({ release: null, counts: {} }), 'utf8'),
  ]);
  await git(workPath, ['add', '.']);
  await git(workPath, ['commit', '-m', 'Base addon source']);
  await git(workPath, ['branch', '-M', 'main']);
  await git(workPath, ['remote', 'add', 'origin', remotePath]);
  await git(workPath, ['push', '-u', 'origin', 'refs/heads/main:refs/heads/main']);
  await fs.writeFile(path.join(workPath, 'release-marker.txt'), 'release\n', 'utf8');
  await git(workPath, ['add', 'release-marker.txt']);
  await git(workPath, ['commit', '-m', 'Release source']);
  await git(workPath, ['tag', TAG]);
  const sourceCommit = (await git(workPath, ['rev-parse', 'HEAD'])).stdout.trim();
  if (pushReleaseRefs) {
    await git(workPath, ['push', '--atomic', 'origin',
      'refs/heads/main:refs/heads/main', `refs/tags/${TAG}:refs/tags/${TAG}`]);
  }

  const archivePath = path.join(artifactDir, ASSET_NAME);
  await execFileAsync('zip', ['-qr', archivePath, 'QuickWoWTalents'], {
    cwd: path.dirname(stagingPath),
  });
  const archiveBytes = await fs.readFile(archivePath);
  for (const executable of ['git', 'gh']) {
    const executablePath = path.join(binDir, executable);
    await fs.writeFile(executablePath, BOUNDARY_SCRIPT, 'utf8');
    await fs.chmod(executablePath, 0o755);
  }

  return {
    archiveBytes,
    archivePath,
    binDir,
    commandLog,
    notesPath,
    remotePath,
    root,
    sourceCommit,
    statePath,
    workPath,
  };
}

async function readState(fixture) {
  return JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
}

async function writeRelease(fixture, { isDraft, bytes = fixture.archiveBytes, assets } = {}) {
  const releaseAssets = assets ?? [{
    name: ASSET_NAME,
    state: 'uploaded',
    size: bytes.byteLength,
    digest: `sha256:${sha256(bytes)}`,
    content: bytes.toString('base64'),
  }];
  await fs.writeFile(fixture.statePath, JSON.stringify({
    counts: {},
    release: { isDraft, isPrerelease: false, assets: releaseAssets },
  }), 'utf8');
}

async function readCommands(fixture) {
  const source = await fs.readFile(fixture.commandLog, 'utf8');
  return source.trim() ? source.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function isMutation(command) {
  if (command.tool === 'git') return command.args[0] === 'push';
  return command.args[0] === 'auth'
    || (command.args[0] === 'release'
      && ['create', 'edit', 'upload', 'delete-asset'].includes(command.args[1]));
}

async function runPublisher(fixture, {
  mode = 'publish',
  expectedSha256 = sha256(fixture.archiveBytes),
  sourceCommit = fixture.sourceCommit,
  env = {},
} = {}) {
  const args = [
    SCRIPT,
    '--mode', mode,
    '--tag', TAG,
    '--archive', fixture.archivePath,
    '--expected-sha256', expectedSha256,
    '--notes-file', fixture.notesPath,
    '--source-commit', sourceCommit,
  ];
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: fixture.workPath,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        COMMAND_LOG: fixture.commandLog,
        GH_STATE: fixture.statePath,
        REAL_GIT,
        ...env,
      },
    });
    return { code: 0, ...result };
  } catch (error) {
    return {
      code: Number(error.code),
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('publish mode checks the digest before authenticated mutation and publishes only a verified draft', async () => {
  const fixture = await createFixture();
  try {
    const result = await runPublisher(fixture, {
      env: { MUTATE_SOURCE_AFTER_CREATE: path.join(fixture.workPath, 'QuickWoWTalents.lua') },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, action: 'published', tag: TAG });

    const commands = await readCommands(fixture);
    const push = commands.find((command) => command.tool === 'git' && command.args[0] === 'push');
    assert.deepEqual(push?.args, [
      'push', '--atomic', 'origin',
      'refs/heads/main:refs/heads/main',
      `refs/tags/${TAG}:refs/tags/${TAG}`,
    ]);
    const ghCommands = commands.filter((command) => command.tool === 'gh');
    const create = ghCommands.find((command) => command.args[1] === 'create');
    assert.deepEqual(create?.args, [
      'release', 'create', TAG, fixture.archivePath,
      '--verify-tag', '--draft', '--title', `QuickWoWTalents ${TAG}`,
      '--notes-file', fixture.notesPath,
    ]);
    assert.deepEqual(
      ghCommands.filter((command) => ['create', 'download', 'edit'].includes(command.args[1]))
        .map((command) => command.args[1]),
      ['create', 'view', 'download', 'edit'].filter((name) => name !== 'view'),
    );
    const createIndex = commands.indexOf(create);
    const downloadIndex = commands.findIndex((command) => command.tool === 'gh' && command.args[1] === 'download');
    const publishIndex = commands.findIndex((command) => command.tool === 'gh'
      && command.args[1] === 'edit' && command.args.includes('--draft=false'));
    assert.ok(createIndex < downloadIndex && downloadIndex < publishIndex);
    assert.equal((await readState(fixture)).release.isDraft, false);

    const remoteRefs = (await git(fixture.workPath, ['ls-remote', 'origin',
      'refs/heads/main', `refs/tags/${TAG}`])).stdout.trim().split('\n').sort();
    assert.deepEqual(remoteRefs, [
      `${fixture.sourceCommit}\trefs/heads/main`,
      `${fixture.sourceCommit}\trefs/tags/${TAG}`,
    ].sort());
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a wrong digest stops immediately before every authenticated mutation', async () => {
  const fixture = await createFixture();
  try {
    const result = await runPublisher(fixture, { expectedSha256: 'a'.repeat(64) });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.deepEqual((await readCommands(fixture)).filter(isMutation), []);
    assert.equal((await readState(fixture)).release, null);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('publish download or semantic verification failure leaves the new release draft', async () => {
  for (const fixtureCase of [
    { name: 'download failure', env: { FAIL_COMMAND: 'gh release download' } },
    { name: 'semantic failure', env: { CORRUPT_CREATED_ASSET: 'true' } },
  ]) {
    const fixture = await createFixture();
    try {
      const result = await runPublisher(fixture, { env: fixtureCase.env });
      assert.notEqual(result.code, 0, fixtureCase.name);
      const commands = await readCommands(fixture);
      assert.equal(commands.some((command) => command.tool === 'gh'
        && command.args[1] === 'edit' && command.args.includes('--draft=false')), false);
      assert.equal(commands.some((command) => command.tool === 'gh'
        && command.args[1] === 'upload'), false);
      assert.equal((await readState(fixture)).release.isDraft, true);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('reconcile repairs a missing release, an interrupted draft, and a confirmed invalid asset', async () => {
  for (const fixtureCase of [
    { name: 'missing', prepare: async () => {} },
    { name: 'draft', prepare: (fixture) => writeRelease(fixture, { isDraft: true }) },
    {
      name: 'invalid asset',
      prepare: (fixture) => writeRelease(fixture, {
        isDraft: false,
        bytes: Buffer.from('not a zip'),
      }),
    },
  ]) {
    const fixture = await createFixture({ pushReleaseRefs: true });
    try {
      await fixtureCase.prepare(fixture);
      const result = await runPublisher(fixture, { mode: 'reconcile' });
      assert.equal(result.code, 0, `${fixtureCase.name}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        action: 'reconciled',
        tag: TAG,
      });
      const commands = await readCommands(fixture);
      assert.equal(commands.some((command) => command.tool === 'git' && command.args[0] === 'push'), false);
      if (fixtureCase.name === 'missing') {
        assert.ok(commands.some((command) => command.tool === 'gh' && command.args[0] === 'api'));
        assert.ok(commands.some((command) => command.tool === 'gh'
          && command.args[1] === 'create' && command.args.includes('--draft')));
      }
      if (fixtureCase.name === 'invalid asset') {
        const draftIndex = commands.findIndex((command) => command.tool === 'gh'
          && command.args[1] === 'edit' && command.args.includes('--draft'));
        const uploadIndex = commands.findIndex((command) => command.tool === 'gh'
          && command.args[1] === 'upload' && command.args.includes('--clobber'));
        const publishIndex = commands.findLastIndex((command) => command.tool === 'gh'
          && command.args[1] === 'edit' && command.args.includes('--draft=false'));
        assert.ok(draftIndex < uploadIndex && uploadIndex < publishIndex);
      }
      const finalState = await readState(fixture);
      assert.equal(finalState.release.isDraft, false);
      assert.equal(finalState.release.assets.length, 1);
      assert.equal(finalState.release.assets[0].digest, `sha256:${sha256(fixture.archiveBytes)}`);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('reconcile returns for an already valid public release without mutation', async () => {
  const fixture = await createFixture({ pushReleaseRefs: true });
  try {
    await writeRelease(fixture, { isDraft: false });
    const result = await runPublisher(fixture, { mode: 'reconcile' });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, action: 'verified', tag: TAG });
    assert.deepEqual((await readCommands(fixture)).filter(isMutation), []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('reconcile rejects a remote tag that does not identify the expected source commit', async () => {
  const fixture = await createFixture({ pushReleaseRefs: true });
  try {
    const baseCommit = (await git(fixture.workPath, ['rev-parse', 'HEAD^'])).stdout.trim();
    await git(fixture.workPath, ['push', '--force', 'origin', `${baseCommit}:refs/tags/${TAG}`]);
    await writeRelease(fixture, { isDraft: true });
    const result = await runPublisher(fixture, { mode: 'reconcile' });
    assert.notEqual(result.code, 0);
    assert.deepEqual((await readCommands(fixture)).filter(isMutation), []);
    assert.equal((await readState(fixture)).release.isDraft, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a transient existing-asset download failure aborts reconciliation before repair', async () => {
  const fixture = await createFixture({ pushReleaseRefs: true });
  try {
    await writeRelease(fixture, { isDraft: true });
    const result = await runPublisher(fixture, {
      mode: 'reconcile',
      env: { FAIL_COMMAND: 'gh release download' },
    });
    assert.notEqual(result.code, 0);
    const mutations = (await readCommands(fixture)).filter(isMutation);
    assert.deepEqual(mutations, []);
    assert.equal((await readState(fixture)).release.isDraft, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('unexpected metadata and command failures are fail-closed and redact boundary output', async () => {
  const secretOutput = 'https://token-value@example.test/private credential=token-value';
  for (const fixtureCase of [
    { name: 'malformed metadata', env: { GH_VIEW_RAW: `{bad ${secretOutput}` } },
    { name: 'failed command', env: { FAIL_COMMAND: 'gh release view', FAIL_OUTPUT: secretOutput } },
  ]) {
    const fixture = await createFixture({ pushReleaseRefs: true });
    try {
      await writeRelease(fixture, { isDraft: true });
      const result = await runPublisher(fixture, { mode: 'reconcile', env: fixtureCase.env });
      assert.notEqual(result.code, 0, fixtureCase.name);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Release publication failed.\n');
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /token-value|https?:\/\//);
      assert.deepEqual((await readCommands(fixture)).filter(isMutation), []);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});
