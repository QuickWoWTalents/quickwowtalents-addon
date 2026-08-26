import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
const PUBLISH_CONDITION = "${{ steps.release_gate.outputs.publish == 'true' }}";
const CONTINUE_CONDITION = "${{ steps.release_gate.outputs.continue == 'true' }}";

const DAILY_STEP_IDS = [
  'checkout_addon',
  'setup_node',
  'install_dependencies',
  'verify_addon_checkout',
  'acquire_inputs',
  'validate_data',
  'verify_code',
  'release_gate',
  'prepare_version',
  'resolve_version',
  'protect_tag',
  'package_addon',
  'readiness',
  'configure_git',
  'commit_release',
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

async function createReleaseRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-release-gate-'));
  const remotePath = path.join(root, 'origin.git');
  const workPath = path.join(root, 'work');
  await fs.mkdir(workPath);
  await git(root, ['init', '--bare', remotePath]);
  await git(workPath, ['init']);
  await git(workPath, ['config', 'user.name', 'Release Gate Test']);
  await git(workPath, ['config', 'user.email', 'release-gate@example.test']);
  await fs.writeFile(path.join(workPath, 'QuickWoWTalentsData.lua'), 'original\n', 'utf8');
  await git(workPath, ['add', 'QuickWoWTalentsData.lua']);
  await git(workPath, ['commit', '-m', 'Initial data']);
  await git(workPath, ['branch', '-M', 'main']);
  await git(workPath, ['remote', 'add', 'origin', remotePath]);
  await git(workPath, ['push', '-u', 'origin', 'main']);
  const baseHead = (await git(workPath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, remotePath, workPath, baseHead };
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
  const eventName = overrides.EVENT_NAME ?? 'schedule';
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
  assert.deepEqual(Object.keys(dailyWorkflow.value.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(dailyWorkflow.value.on.schedule, [{ cron: '30 17 * * *' }]);
  assert.deepEqual(dailyWorkflow.value.permissions, { contents: 'write' });
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

for (const [name, workflow] of [
  ['pull request', prWorkflow],
  ['daily release', dailyWorkflow],
]) {
  test(`${name} acquires one production snapshot from the public endpoint contract`, () => {
    const addonCheckout = requireStep(workflow, 'checkout_addon');
    const acquire = requireStep(workflow, 'acquire_inputs');
    const validate = requireStep(workflow, 'validate_data');
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
    assert.match(validate.run, /--options "\$QWT_ADDON_OPTIONS_PATH"/);
    assert.match(validate.run, /--catalog "\$QWT_TALENT_CATALOG_PATH"/);
    assert.match(validate.run, /--snapshot-manifest "\$QWT_RELEASE_INPUT_MANIFEST_PATH"/);
    assert.match(validate.run, /--require-catalog-download/);
    assert.match(readiness.run, /--options "\$QWT_ADDON_OPTIONS_PATH"/);
    assert.match(readiness.run, /--catalog "\$QWT_TALENT_CATALOG_PATH"/);
    assert.match(readiness.run, /--snapshot-manifest "\$QWT_RELEASE_INPUT_MANIFEST_PATH"/);
    assert.match(readiness.run, /--require-catalog-download/);
  });
}

test('tracked release-facing content uses portable paths and public project identifiers', async () => {
  const { stdout } = await execFileAsync('git', [
    'ls-files',
    '.github',
    'README.md',
    'RELEASING.md',
    'docs',
    'scripts',
    'test',
    'package.json',
    'package-lock.json',
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  const files = stdout.trim().split('\n').filter(Boolean);
  const contents = (await Promise.all(
    files.map((file) => fs.readFile(path.join(REPO_ROOT, file), 'utf8')),
  )).join('\n');
  assert.doesNotMatch(contents, /\/Users\//);
  assert.doesNotMatch(contents, /\b[a-z0-9-]+-builds\b/i);
});

test('public build generation has no external product repository import hooks', async () => {
  const [builder, research] = await Promise.all([
    fs.readFile(path.join(REPO_ROOT, 'scripts/build-data.mjs'), 'utf8'),
    fs.readFile(path.join(REPO_ROOT, 'docs/research.md'), 'utf8'),
  ]);
  const forbiddenBuilderPatterns = [
    new RegExp(['QWT', 'PRODUCT', 'REPO'].join('_')),
    new RegExp(['--local', '-repo'].join('')),
    new RegExp(['build', '-service\\.mjs'].join('')),
    new RegExp(['path', 'ToFile', 'URL'].join('')),
    /process\s*\.\s*chdir\s*\(/,
    /\bimport\s*\(/,
  ];
  for (const pattern of forbiddenBuilderPatterns) assert.doesNotMatch(builder, pattern);
  assert.doesNotMatch(research, new RegExp(['main', ' QWT', ' repo'].join(''), 'i'));
  assert.match(research, /public.*(?:endpoint|snapshot)/i);
});

test('daily conditions keep all gates before versioning and publication exact', () => {
  const unconditionalIds = [
    'checkout_addon', 'setup_node', 'install_dependencies',
    'verify_addon_checkout', 'acquire_inputs',
    'validate_data', 'verify_code', 'release_gate',
  ];
  for (const id of unconditionalIds) assert.equal(requireStep(dailyWorkflow, id).if, undefined);
  for (const id of ['prepare_version', 'protect_tag', 'configure_git', 'commit_release', 'publish_release']) {
    assert.equal(requireStep(dailyWorkflow, id).if, PUBLISH_CONDITION);
  }
  for (const id of ['resolve_version', 'package_addon', 'readiness']) {
    assert.equal(requireStep(dailyWorkflow, id).if, CONTINUE_CONDITION);
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
  assert.match(tagGuard.run, /git tag --list "\$RELEASE_TAG"/);
  assert.match(tagGuard.run, /git ls-remote --tags origin "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(tagGuard.run, /already exists; refusing to overwrite a release/);
  assert.ok(stepIds(dailyWorkflow).indexOf('protect_tag') < stepIds(dailyWorkflow).indexOf('package_addon'));
});

test('release decision emits the expected manual, scheduled, and dry-run output matrix', async () => {
  const cases = [
    {
      name: 'non-main manual dry-run',
      env: { EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'true', GITHUB_REF: 'refs/heads/feature' },
      want: { continue: 'true', publish: 'false', reason: 'dry-run' },
    },
    {
      name: 'main manual full release',
      env: { EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/main' },
      want: { continue: 'true', publish: 'true', reason: 'manual-full-release' },
    },
    {
      name: 'main unchanged schedule',
      env: { EVENT_NAME: 'schedule', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/main' },
      want: { continue: 'false', publish: 'false', reason: 'data-unchanged' },
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

test('release decision rejects every publishing event outside current main', async () => {
  for (const env of [
    { EVENT_NAME: 'workflow_dispatch', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/feature' },
    { EVENT_NAME: 'schedule', DRY_RUN: 'false', GITHUB_REF: 'refs/heads/feature' },
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

test('scheduled comparison detects staged and unstaged data relative to HEAD and rejects git errors', async () => {
  for (const state of ['unstaged', 'staged']) {
    const fixture = await createReleaseRepository();
    try {
      await fs.writeFile(path.join(fixture.workPath, 'QuickWoWTalentsData.lua'), `${state}\n`, 'utf8');
      if (state === 'staged') await git(fixture.workPath, ['add', 'QuickWoWTalentsData.lua']);
      const result = await runReleaseGate(fixture);
      assert.equal(result.error, null, result.stderr);
      assert.deepEqual(result.outputs, { continue: 'true', publish: 'true', reason: 'data-changed' });
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

test('publication authenticates only at the end and atomically pushes fully qualified refs', () => {
  const publish = requireStep(dailyWorkflow, 'publish_release');
  const tokenSteps = dailyWorkflow.steps.filter((step) => (
    Object.values(step.env ?? {}).includes('${{ github.token }}')
  ));
  assert.deepEqual(tokenSteps.map((step) => step.id), ['publish_release']);
  assert.equal(dailyWorkflow.value.env.GH_TOKEN, undefined);
  assert.equal(publish.env.GH_TOKEN, '${{ github.token }}');
  assert.match(publish.run, /gh auth setup-git/);
  assert.match(publish.run, /git push --atomic origin/);
  assert.match(publish.run, /"HEAD:refs\/heads\/main"/);
  assert.match(publish.run, /"refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG"/);
  assert.match(publish.run, /gh release create "\$RELEASE_TAG" "\$RELEASE_ZIP"/);
  assert.match(publish.run, /--verify-tag/);

  const authIndex = publish.run.indexOf('gh auth setup-git');
  const pushIndex = publish.run.indexOf('git push --atomic');
  const releaseIndex = publish.run.indexOf('gh release create');
  assert.equal([...publish.run.matchAll(/\bgit push\b/g)].length, 1);
  assert.equal([...publish.run.matchAll(/\bgh release create\b/g)].length, 1);
  assert.ok(authIndex !== -1 && authIndex < pushIndex);
  assert.ok(pushIndex < releaseIndex);
  for (const step of dailyWorkflow.steps) {
    if (step.id === 'publish_release') continue;
    assert.doesNotMatch(
      JSON.stringify(step),
      /github\.token|GH_TOKEN|gh auth setup-git|\bgit push\b|\bgh release create\b/,
    );
  }
});

test('digest comparison is adjacent to publication and no later command mutates the archive', () => {
  const publish = requireStep(dailyWorkflow, 'publish_release');
  const digestAssignment = publish.run.indexOf('ACTUAL_SHA256=');
  const digestComparison = publish.run.indexOf('if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]');
  const digestGuardEnd = publish.run.indexOf('\nfi', digestComparison);
  const pushIndex = publish.run.indexOf('git push --atomic');
  assert.ok(digestAssignment !== -1 && digestAssignment < digestComparison);
  assert.ok(digestComparison < digestGuardEnd && digestGuardEnd < pushIndex);

  const afterDigest = publish.run.slice(digestGuardEnd + '\nfi'.length).trim();
  assert.deepEqual(afterDigest.split('\n').map((line) => line.trim()), [
    'gh auth setup-git',
    'git push --atomic origin \\',
    '"HEAD:refs/heads/main" \\',
    '"refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
    'gh release create "$RELEASE_TAG" "$RELEASE_ZIP" \\',
    '--verify-tag \\',
    '--title "QuickWoWTalents $RELEASE_TAG" \\',
    '--notes-file "$RUNNER_TEMP/release-notes.md"',
  ]);
  assert.equal(dailyWorkflow.steps.at(-1).id, 'publish_release');
});
