import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAILY_WORKFLOW_URL = new URL('../.github/workflows/daily-release.yml', import.meta.url);
const PR_WORKFLOW_URL = new URL('../.github/workflows/pull-request.yml', import.meta.url);
const PUBLISH_CONDITION = "${{ steps.release_gate.outputs.mode == 'publish' }}";
const ACTIVE_CONDITION = "${{ steps.release_gate.outputs.mode != 'no-op' }}";
const PUBLICATION_CONDITION = "${{ steps.release_gate.outputs.mode == 'publish' || steps.release_gate.outputs.mode == 'reconcile' }}";

const DAILY_STEP_IDS = [
  'checkout_addon',
  'setup_node',
  'install_dependencies',
  'verify_addon_checkout',
  'acquire_inputs',
  'verify_code',
  'release_gate',
  'prepare_version',
  'resolve_version',
  'protect_tag',
  'package_addon',
  'readiness',
  'configure_git',
  'commit_release',
  'verify_release_tree',
  'publish_release',
];

const PR_STEP_IDS = [
  'checkout_addon',
  'setup_node',
  'install_dependencies',
  'verify_addon_checkout',
  'acquire_inputs',
  'validate_data',
  'verify_code',
  'package_addon',
  'readiness',
];

async function loadWorkflow(url, jobId) {
  const source = await fs.readFile(url, 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  return {
    source,
    document,
    value: document.toJS(),
    get steps() {
      return this.value.jobs[jobId].steps;
    },
  };
}

const [dailyWorkflow, prWorkflow] = await Promise.all([
  loadWorkflow(DAILY_WORKFLOW_URL, 'release'),
  loadWorkflow(PR_WORKFLOW_URL, 'test'),
]);

function requireStep(workflow, id) {
  const step = workflow.steps.find((candidate) => candidate.id === id);
  assert.ok(step, `workflow must contain step id ${JSON.stringify(id)}`);
  return step;
}

function stepIds(workflow) {
  return workflow.steps.map((step) => step.id);
}

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function trackedTextFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const files = stdout.split('\0').filter(Boolean);
  const entries = await Promise.all(files.map(async (file) => {
    const content = await fs.readFile(path.join(REPO_ROOT, file));
    return content.includes(0) ? null : { file, source: content.toString('utf8') };
  }));
  return entries.filter(Boolean);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createReleaseRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-release-gate-'));
  const remotePath = path.join(root, 'origin.git');
  const workPath = path.join(root, 'work');
  await fs.mkdir(workPath);
  await git(root, ['init', '--bare', remotePath]);
  await git(workPath, ['init']);
  await git(workPath, ['config', 'user.name', 'Release Gate Test']);
  await git(workPath, ['config', 'user.email', 'release-gate@example.test']);
  await fs.writeFile(path.join(workPath, 'package.json'), '{"version":"1.2.3"}\n', 'utf8');
  await fs.writeFile(path.join(workPath, 'QuickWoWTalentsData.lua'), 'original\n', 'utf8');
  await git(workPath, ['add', 'package.json', 'QuickWoWTalentsData.lua']);
  await git(workPath, ['commit', '-m', 'Initial data']);
  await git(workPath, ['branch', '-M', 'main']);
  await git(workPath, ['remote', 'add', 'origin', remotePath]);
  await git(workPath, ['push', '-u', 'origin', 'main']);
  const baseHead = (await git(workPath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, remotePath, workPath, baseHead };
}

async function tagCurrentRelease(fixture) {
  await git(fixture.workPath, ['tag', 'v1.2.3']);
  await git(fixture.workPath, ['push', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3']);
}

async function advanceRemoteMain(fixture) {
  const upstreamPath = path.join(fixture.root, 'upstream');
  await git(fixture.root, ['clone', '--branch', 'main', fixture.remotePath, upstreamPath]);
  await git(upstreamPath, ['config', 'user.name', 'Upstream Test']);
  await git(upstreamPath, ['config', 'user.email', 'upstream@example.test']);
  await fs.writeFile(path.join(upstreamPath, 'upstream.txt'), 'advanced\n', 'utf8');
  await git(upstreamPath, ['add', 'upstream.txt']);
  await git(upstreamPath, ['commit', '-m', 'Advance main']);
  await git(upstreamPath, ['push', 'origin', 'HEAD:main']);
}

function parseOutputs(text) {
  const entries = text.trim() ? text.trim().split('\n') : [];
  return Object.fromEntries(entries.map((line) => {
    const separator = line.indexOf('=');
    assert.notEqual(separator, -1, `invalid workflow output line ${JSON.stringify(line)}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function runReleaseGate(fixture, overrides = {}) {
  const outputPath = path.join(
    fixture.root,
    `github-output-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await fs.writeFile(outputPath, '', 'utf8');
  const eventName = overrides.EVENT_NAME ?? 'repository_dispatch';
  const dryRun = overrides.DRY_RUN ?? 'false';
  const env = {
    ...process.env,
    BASE_HEAD: fixture.baseHead,
    DRY_RUN: dryRun,
    EVENT_NAME: eventName,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: overrides.GITHUB_REF ?? 'refs/heads/main',
    ...overrides,
  };

  let error = null;
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(
      'bash',
      ['-c', requireStep(dailyWorkflow, 'release_gate').run],
      { cwd: fixture.workPath, env, encoding: 'utf8' },
    ));
  } catch (caught) {
    error = caught;
    stdout = caught.stdout ?? '';
    stderr = caught.stderr ?? '';
  }

  return {
    error,
    outputs: parseOutputs(await fs.readFile(outputPath, 'utf8')),
    stderr,
    stdout,
  };
}

test('workflow files parse as unique-key YAML documents with exact triggers and permissions', () => {
  assert.deepEqual(dailyWorkflow.document.errors, []);
  assert.deepEqual(prWorkflow.document.errors, []);
  assert.deepEqual(Object.keys(dailyWorkflow.value.on).sort(), [
    'repository_dispatch',
    'workflow_dispatch',
  ]);
  assert.deepEqual(dailyWorkflow.value.on.repository_dispatch, {
    types: ['daily-release-fallback'],
  });
  assert.deepEqual(dailyWorkflow.value.permissions, { contents: 'write' });
  assert.deepEqual(dailyWorkflow.value.concurrency, {
    group: 'daily-addon-release',
    'cancel-in-progress': false,
  });
  assert.equal(dailyWorkflow.value.on.workflow_dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(dailyWorkflow.value.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(prWorkflow.value.on, { pull_request: null });
  assert.deepEqual(prWorkflow.value.permissions, { contents: 'read' });
});

test('workflows expose unique stable step ids in the complete release order', () => {
  assert.deepEqual(stepIds(dailyWorkflow), DAILY_STEP_IDS);
  assert.deepEqual(stepIds(prWorkflow), PR_STEP_IDS);
  assert.equal(new Set(stepIds(dailyWorkflow)).size, DAILY_STEP_IDS.length);
  assert.equal(new Set(stepIds(prWorkflow)).size, PR_STEP_IDS.length);
  assert.ok([...dailyWorkflow.steps, ...prWorkflow.steps].every((step) => step['continue-on-error'] !== true));
});

for (const [name, workflow] of [['pull request', prWorkflow], ['daily release', dailyWorkflow]]) {
  test(`${name} acquires one production snapshot for final readiness`, () => {
    const addonCheckout = requireStep(workflow, 'checkout_addon');
    const acquire = requireStep(workflow, 'acquire_inputs');
    const readiness = requireStep(workflow, 'readiness');

    assert.equal(addonCheckout.uses, 'actions/checkout@v4');
    assert.equal(addonCheckout.with['persist-credentials'], false);
    assert.equal(workflow.steps.filter((step) => step.uses === 'actions/checkout@v4').length, 1);
    assert.equal(addonCheckout.with.repository, undefined);
    assert.equal(addonCheckout.with.token, undefined);
    assert.equal(workflow.value.env.QWT_ADDON_DATA_URL, 'https://quickwowtalents.com/api/addon-data');
    assert.equal(workflow.value.env.QWT_OPTIONS_URL, 'https://quickwowtalents.com/api/options');
    assert.match(workflow.value.env.QWT_TALENT_CATALOG_PATH, /tmp\/release-inputs\/talent-catalog\.json\.gz$/);
    assert.match(workflow.value.env.QWT_ADDON_OPTIONS_PATH, /tmp\/release-inputs\/options\.json$/);
    assert.match(workflow.value.env.QWT_RELEASE_INPUT_MANIFEST_PATH, /tmp\/release-inputs\/snapshot-manifest\.json$/);
    assert.match(acquire.run, /--options-output "\$QWT_ADDON_OPTIONS_PATH"/);
    assert.match(acquire.run, /--catalog-output "\$QWT_TALENT_CATALOG_PATH"/);
    assert.match(acquire.run, /--snapshot-manifest-output "\$QWT_RELEASE_INPUT_MANIFEST_PATH"/);
    assert.doesNotMatch(acquire.run, /(?:^|\s)--catalog(?:\s|$)/m);
    assert.match(readiness.run, /--options "\$QWT_ADDON_OPTIONS_PATH"/);
    assert.match(readiness.run, /--catalog "\$QWT_TALENT_CATALOG_PATH"/);
    assert.match(readiness.run, /--snapshot-manifest "\$QWT_RELEASE_INPUT_MANIFEST_PATH"/);
    assert.match(readiness.run, /--require-catalog-download/);
  });
}

test('daily acquisition and code gates fit the bounded orchestration contract', () => {
  const job = dailyWorkflow.value.jobs.release;
  const acquire = requireStep(dailyWorkflow, 'acquire_inputs');
  const verify = requireStep(dailyWorkflow, 'verify_code');

  assert.equal(job['timeout-minutes'], 20);
  assert.equal(acquire.env.QWT_ADDON_DATA_RETRIES, '2');
  assert.equal(acquire.env.QWT_ADDON_DATA_RETRY_DELAY_MS, '30000');
  assert.equal(verify.run, 'npm test');
  assert.equal(stepIds(dailyWorkflow).includes('validate_data'), false);
  assert.doesNotMatch(dailyWorkflow.source, /\bnode --check\b/);
});

test('all tracked text uses portable paths and approved public identifiers', async () => {
  const entries = await trackedTextFiles();
  const approvedHosts = new Set([
    'github.com',
    'quickwowtalents.com',
    'registry.npmjs.org',
  ]);
  const forbiddenIdentifierHashes = new Set([
    '2b2882e3ccb2cbebad0eca914f2503829579b44d8c67f6659e893b75885061ff',
    'd89d1f644c210b2bb89251f25a70e3093dbfb1ef1360882e214008c742d29d41',
    '9279d1ed92b99c3f5679f9d8fa017b1ec6cf0cb47e43cbd84e61f4e6efeca0ee',
    '85229e67a6bd53b0520b64ec147e901269e9d9561926baabcd57207467c5f1b6',
    'f2a6ce36f92ea66f8c726c7736adef7ffa5ac5acc6b4bec60ff39b39057f057b',
    '56d15b754602815534f9f504e97a24ddeac9ffeb33cdf0e5695ccaa24d1998ec',
    '9fd19c0a3f3d125b54775b7c55e3019ce118ad8365f24c2c902c094160e21b01',
  ]);
  const portablePathPatterns = [
    new RegExp(['/', 'Users', '/[^/\\s]+/'].join(''), 'i'),
    new RegExp(['/', 'home', '/[^/\\s]+/'].join(''), 'i'),
    new RegExp(['[A-Za-z]:\\\\', 'Users', '\\\\'].join(''), 'i'),
  ];

  for (const { file, source } of entries) {
    for (const pattern of portablePathPatterns) {
      assert.doesNotMatch(source, pattern, `${file} must not contain a machine-specific path`);
    }

    for (const match of source.matchAll(/https?:\/\/[^\s"'<>`]+/g)) {
      const rawUrl = match[0].replace(/[),.;:]+$/, '');
      const hostname = new URL(rawUrl).hostname.toLowerCase();
      const isSynthetic = hostname.endsWith('.test') || hostname.endsWith('.example');
      assert.ok(
        approvedHosts.has(hostname) || isSynthetic,
        `${file} must not reference an unapproved URL host`,
      );
    }

    const tokens = source.toLowerCase().match(/[a-z0-9._-]+/g) ?? [];
    const candidates = new Set(tokens);
    for (const token of tokens) {
      const parts = token.split('-').filter(Boolean);
      for (let start = 0; start < parts.length; start += 1) {
        for (let end = start + 2; end <= parts.length; end += 1) {
          candidates.add(parts.slice(start, end).join('-'));
        }
      }
    }
    assert.ok(
      [...candidates].every((candidate) => !forbiddenIdentifierHashes.has(sha256(candidate))),
      `${file} must not contain a non-public project identifier`,
    );
  }
});

test('repository tracks only public Markdown documents', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files', '*.md'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const files = stdout.trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['CHANGELOG.md', 'CURSEFORGE_CHANGELOG.md', 'README.md']);

  const readme = await fs.readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [
    'What it does',
    'Install',
    'Updating',
    'Data source and privacy',
    'Known limitations',
    'Support',
    'License',
  ]);
});

test('public build generation is self-contained and uses the public endpoint', async () => {
  const builder = await fs.readFile(path.join(REPO_ROOT, 'scripts/build-data.mjs'), 'utf8');
  const importSpecifiers = [
    ...[...builder.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...builder.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]),
  ];
  assert.ok(importSpecifiers.length > 0);
  assert.ok(importSpecifiers.every((specifier) => (
    specifier.startsWith('node:') || specifier.startsWith('./')
  )));
  assert.doesNotMatch(builder, /process\s*\.\s*chdir\s*\(/);
  assert.doesNotMatch(builder, /\bimport\s*\(/);
  assert.match(builder, /https:\/\/quickwowtalents\.com/);
});

test('daily conditions package active modes but mutate only new releases', () => {
  const unconditionalIds = [
    'checkout_addon', 'setup_node', 'install_dependencies',
    'verify_addon_checkout', 'acquire_inputs', 'verify_code', 'release_gate',
  ];
  for (const id of unconditionalIds) assert.equal(requireStep(dailyWorkflow, id).if, undefined);
  for (const id of ['prepare_version', 'protect_tag', 'configure_git', 'commit_release']) {
    assert.equal(requireStep(dailyWorkflow, id).if, PUBLISH_CONDITION);
  }
  for (const id of ['resolve_version', 'package_addon', 'readiness']) {
    assert.equal(requireStep(dailyWorkflow, id).if, ACTIVE_CONDITION);
  }
  for (const id of ['verify_release_tree', 'publish_release']) {
    assert.equal(requireStep(dailyWorkflow, id).if, PUBLICATION_CONDITION);
  }
  assert.equal(requireStep(dailyWorkflow, 'setup_node').with['node-version'], '22');
  assert.equal(requireStep(dailyWorkflow, 'install_dependencies').run, 'npm ci');
});

test('pull-request production gates are unconditional, ordered, read-only, and non-publishing', () => {
  assert.ok(prWorkflow.steps.every((step) => step.if === undefined));
  assert.equal(requireStep(prWorkflow, 'setup_node').with['node-version'], '22');
  assert.equal(requireStep(prWorkflow, 'install_dependencies').run, 'npm ci');
  assert.doesNotMatch(
    prWorkflow.source,
    /\bgh auth setup-git\b|\bgit commit\b|\bgit tag\b|\bgit push\b|\bgh release create\b|GH_TOKEN/,
  );
});

test('release decision is bound to event type, main ref, checkout base, and fresh remote main', () => {
  const checkoutGuard = requireStep(dailyWorkflow, 'verify_addon_checkout');
  const gate = requireStep(dailyWorkflow, 'release_gate');
  assert.match(checkoutGuard.run, /git status --porcelain --untracked-files=all/);
  assert.match(checkoutGuard.run, /head=.*GITHUB_OUTPUT|GITHUB_OUTPUT.*head/s);
  assert.equal(gate.env.BASE_HEAD, '${{ steps.verify_addon_checkout.outputs.head }}');
  assert.equal(gate.env.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(
    gate.env.DRY_RUN,
    "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run == true }}",
  );
  assert.match(gate.run, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(gate.run, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.match(gate.run, /BASE_HEAD.*REMOTE_MAIN_HEAD|REMOTE_MAIN_HEAD.*BASE_HEAD/s);
});

test('tag protection checks local and remote fully qualified tags before packaging', () => {
  const tagGuard = requireStep(dailyWorkflow, 'protect_tag');
  assert.match(tagGuard.run, /^set -euo pipefail/m);
  assert.match(tagGuard.run, /git show-ref --verify --quiet "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(tagGuard.run, /git ls-remote --refs origin "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(tagGuard.run, /already exists; refusing to overwrite a release/);
  assert.ok(stepIds(dailyWorkflow).indexOf('protect_tag') < stepIds(dailyWorkflow).indexOf('package_addon'));
});

test('release decision emits one mode for manual, fallback, and dry-run behavior', async () => {
  const cases = [
    {
      name: 'non-main manual dry-run',
      env: { EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'true', GITHUB_REF: 'refs/heads/feature' },
      want: { mode: 'dry-run' },
    },
    {
      name: 'main manual full release',
      env: { EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/main' },
      want: { mode: 'publish' },
    },
    {
      name: 'main unchanged external fallback without a current release tag',
      env: { EVENT_NAME: 'repository_dispatch', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/main' },
      want: { mode: 'no-op' },
    },
  ];

  for (const fixtureCase of cases) {
    const fixture = await createReleaseRepository();
    try {
      const result = await runReleaseGate(fixture, fixtureCase.env);
      assert.equal(result.error, null, `${fixtureCase.name}: ${result.stderr}`);
      assert.deepEqual(result.outputs, fixtureCase.want, fixtureCase.name);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('unchanged fallback reconciles only when the package-version tag identifies HEAD', async () => {
  const fixture = await createReleaseRepository();
  try {
    await tagCurrentRelease(fixture);
    const result = await runReleaseGate(fixture);
    assert.equal(result.error, null, result.stderr);
    assert.deepEqual(result.outputs, { mode: 'reconcile' });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('unchanged fallback no-ops after an untagged code-only main advance', async () => {
  const fixture = await createReleaseRepository();
  try {
    await tagCurrentRelease(fixture);
    await fs.writeFile(path.join(fixture.workPath, 'code.txt'), 'code-only change\n', 'utf8');
    await git(fixture.workPath, ['add', 'code.txt']);
    await git(fixture.workPath, ['commit', '-m', 'Advance code only']);
    await git(fixture.workPath, ['push', 'origin', 'HEAD:main']);
    fixture.baseHead = (await git(fixture.workPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const result = await runReleaseGate(fixture);
    assert.equal(result.error, null, result.stderr);
    assert.deepEqual(result.outputs, { mode: 'no-op' });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('release decision rejects every publishing event outside current main', async () => {
  for (const env of [
    { EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/feature' },
    { EVENT_NAME: 'repository_dispatch', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/feature' },
    { EVENT_NAME: 'pull_request', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/main' },
  ]) {
    const fixture = await createReleaseRepository();
    try {
      const result = await runReleaseGate(fixture, env);
      assert.ok(result.error, `event/ref ${env.EVENT_NAME}/${env.GITHUB_REF} must fail`);
      assert.deepEqual(result.outputs, {});
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('release decision rejects a main checkout behind freshly queried remote main', async () => {
  const fixture = await createReleaseRepository();
  try {
    await advanceRemoteMain(fixture);
    const result = await runReleaseGate(fixture, {
      EVENT_NAME: 'workflow_dispatch',
      DRY_RUN: 'false',
      GITHUB_REF: 'refs/heads/main',
    });
    assert.ok(result.error);
    assert.match(result.stderr, /remote main|origin\/main|base HEAD/i);
    assert.deepEqual(result.outputs, {});
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('external fallback rejects an unrelated main advance', async () => {
  const fixture = await createReleaseRepository();
  try {
    await advanceRemoteMain(fixture);
    const result = await runReleaseGate(fixture);
    assert.ok(result.error);
    assert.match(result.stderr, /remote main|origin\/main|base HEAD/i);
    assert.deepEqual(result.outputs, {});
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('fallback comparison publishes staged or unstaged data changes and rejects git errors', async () => {
  for (const state of ['unstaged', 'staged']) {
    const fixture = await createReleaseRepository();
    try {
      await fs.writeFile(path.join(fixture.workPath, 'QuickWoWTalentsData.lua'), `${state}\n`, 'utf8');
      if (state === 'staged') await git(fixture.workPath, ['add', 'QuickWoWTalentsData.lua']);
      const result = await runReleaseGate(fixture);
      assert.equal(result.error, null, result.stderr);
      assert.deepEqual(result.outputs, { mode: 'publish' });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }

  const fixture = await createReleaseRepository();
  try {
    const corruptIndex = path.join(fixture.root, 'corrupt-index');
    await fs.writeFile(corruptIndex, 'not a git index\n', 'utf8');
    const result = await runReleaseGate(fixture, { GIT_INDEX_FILE: corruptIndex });
    assert.ok(result.error);
    assert.match(result.stderr, /Could not compare validated addon data/);
    assert.deepEqual(result.outputs, {});
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  assert.match(requireStep(dailyWorkflow, 'release_gate').run, /git diff --quiet HEAD -- QuickWoWTalentsData\.lua/);
});

test('release commit is allowlisted and followed by a clean-tree source handoff', () => {
  const commit = requireStep(dailyWorkflow, 'commit_release');
  const verifyTree = requireStep(dailyWorkflow, 'verify_release_tree');
  const expectedFiles = [
    'package.json',
    'QuickWoWTalents.toc',
    'QuickWoWTalentsData.lua',
    'CHANGELOG.md',
    'CURSEFORGE_CHANGELOG.md',
  ];

  assert.match(commit.run, new RegExp(`git add ${expectedFiles.join(' ')}`));
  assert.match(commit.run, /git commit -m "Daily addon data release \$RELEASE_TAG"/);
  assert.match(commit.run, /git tag "\$RELEASE_TAG"/);
  assert.equal(verifyTree.env.BASE_HEAD, '${{ steps.verify_addon_checkout.outputs.head }}');
  assert.match(verifyTree.run, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.match(verifyTree.run, /BASE_HEAD.*REMOTE_MAIN_HEAD|REMOTE_MAIN_HEAD.*BASE_HEAD/s);
  assert.match(verifyTree.run, /git status --porcelain --untracked-files=all/);
  assert.match(verifyTree.run, /head=.*GITHUB_OUTPUT|GITHUB_OUTPUT.*head/s);
  assert.ok(stepIds(dailyWorkflow).indexOf('commit_release') < stepIds(dailyWorkflow).indexOf('verify_release_tree'));
  assert.ok(stepIds(dailyWorkflow).indexOf('verify_release_tree') < stepIds(dailyWorkflow).indexOf('publish_release'));
});

test('publisher script is the only remote publication entry point with exact verified inputs', () => {
  const publish = requireStep(dailyWorkflow, 'publish_release');
  const tokenSteps = dailyWorkflow.steps.filter((step) => (
    Object.values(step.env ?? {}).includes('${{ github.token }}')
  ));
  assert.deepEqual(tokenSteps.map((step) => step.id), ['publish_release']);
  assert.equal(dailyWorkflow.value.env.GH_TOKEN, undefined);
  assert.equal(publish.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(publish.env.PUBLISH_MODE, '${{ steps.release_gate.outputs.mode }}');
  assert.equal(publish.env.EXPECTED_SHA256, '${{ steps.readiness.outputs.zip_sha256 }}');
  assert.equal(publish.env.SOURCE_COMMIT, '${{ steps.verify_release_tree.outputs.head }}');
  assert.equal([...dailyWorkflow.source.matchAll(/npm run release:publish/g)].length, 1);
  assert.match(publish.run, /^npm run release:publish -- \\/m);
  assert.match(publish.run, /--mode "\$PUBLISH_MODE"/);
  assert.match(publish.run, /--tag "\$RELEASE_TAG"/);
  assert.match(publish.run, /--archive "\$RELEASE_ZIP"/);
  assert.match(publish.run, /--expected-sha256 "\$EXPECTED_SHA256"/);
  assert.match(publish.run, /--notes-file CURSEFORGE_CHANGELOG\.md/);
  assert.match(publish.run, /--source-commit "\$SOURCE_COMMIT"/);
  assert.doesNotMatch(dailyWorkflow.source, /\bgh auth setup-git\b|\bgit push\b|\bgh release (?:create|view|download|upload|edit)\b/);
  assert.doesNotMatch(dailyWorkflow.source, /node scripts\/publish-release\.mjs/);
  assert.equal(dailyWorkflow.steps.at(-1).id, 'publish_release');
});
