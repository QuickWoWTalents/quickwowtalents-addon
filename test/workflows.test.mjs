import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseDocument } from 'yaml';

const workflows = [
  ['pull request', new URL('../.github/workflows/pull-request.yml', import.meta.url)],
  ['daily release', new URL('../.github/workflows/daily-release.yml', import.meta.url)]
];

for (const [name, workflowUrl] of workflows) {
  test(`${name} protects Actions and application HTTPS runtimes before any repository operation`, async () => {
    const document = parseDocument(await readFile(workflowUrl, 'utf8'), { uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    const workflow = document.toJS();
    const [job] = Object.values(workflow.jobs);
    const [bootstrap] = job.steps;
    assert.equal(workflow.env.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, 'true');
    assert.equal(bootstrap.id, 'bootstrap_actions_node');
    assert.equal(bootstrap.shell, 'bash');
    assert.equal(bootstrap.uses, undefined);
    assert.equal(bootstrap.if, undefined);
    assert.match(bootstrap.run, /^set -euo pipefail/m);
    assert.match(bootstrap.run, /github-hosted:Linux:X64/);
    assert.match(bootstrap.run, /\[ -z "\$\{ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION:-\}" \]/);
    assert.match(bootstrap.run, /https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-x64\.tar\.xz/);
    assert.match(bootstrap.run, /6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6/);
    assert.match(bootstrap.run, /sha256sum --check --status/);
    assert.ok(bootstrap.run.indexOf('sha256sum --check --status') < bootstrap.run.indexOf('tar -xJf'));
    assert.match(bootstrap.run, /Runner\.Worker/);
    assert.match(bootstrap.run, /externals\/node24\/bin\/node/);
    assert.ok(bootstrap.run.indexOf('v24.22.1') < bootstrap.run.indexOf('install -m 755'));
    assert.match(bootstrap.run, /mv -f "\$ACTIONS_NODE\.qwt" "\$ACTIONS_NODE"/);
    assert.doesNotMatch(bootstrap.run, /continue-on-error|\|\| true|\bnode20\b/);

    const setup = job.steps.find((step) => step.id === 'setup_node');
    const verifyIndex = job.steps.findIndex((step) => step.id === 'verify_hosted_runtimes');
    const installIndex = job.steps.findIndex((step) => step.id === 'install_dependencies');
    assert.equal(setup.with['node-version'], '24.22.1');
    assert.equal(setup.with['package-manager-cache'], false);
    assert.ok(verifyIndex > job.steps.indexOf(setup));
    assert.ok(verifyIndex < installIndex);
    assert.equal(job.steps[verifyIndex].run, 'bash .github/scripts/install-hosted-runtimes.sh');
    assert.equal(job.steps[verifyIndex].env.ACTIONS_NODE, '${{ steps.bootstrap_actions_node.outputs.runner_node }}');
  });

  test(`${name} workflow installs locked dependencies before repository scripts`, async () => {
    const source = await readFile(workflowUrl, 'utf8');
    const setupNodeIndex = source.indexOf('uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
    const npmCiIndex = source.indexOf('run: npm ci');
    const firstRepositoryScriptIndex = Math.min(
      ...['node --check', 'npm test', 'npm run'].map((command) => {
        const index = source.indexOf(command);
        return index === -1 ? Number.POSITIVE_INFINITY : index;
      })
    );

    assert.notEqual(setupNodeIndex, -1);
    assert.notEqual(npmCiIndex, -1);
    assert.ok(npmCiIndex > setupNodeIndex, 'npm ci must run after Node setup');
    assert.ok(npmCiIndex < firstRepositoryScriptIndex, 'npm ci must run before repository scripts');
  });
}

test('both workflows use the identical pre-checkout Actions bootstrap', async () => {
  const documents = await Promise.all(workflows.map(async ([, url]) => (
    parseDocument(await readFile(url, 'utf8')).toJS()
  )));
  const bootstraps = documents.map((workflow) => Object.values(workflow.jobs)[0].steps[0]);
  assert.deepEqual(bootstraps[0], bootstraps[1]);
});

test('hosted CLI installer verifies the archive and embedded Go before exposing gh', async () => {
  const source = await readFile(new URL('../.github/scripts/install-hosted-runtimes.sh', import.meta.url), 'utf8');
  assert.match(source, /^set -euo pipefail/m);
  assert.match(source, /github-hosted:Linux:X64/);
  assert.match(source, /gh_2\.102\.1_linux_amd64\.tar\.gz/);
  assert.match(source, /77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b/);
  assert.ok(source.indexOf('sha256sum --check --status') < source.indexOf('tar -xzf'));
  assert.match(source, /GOTOOLCHAIN=local go version -m "\$GH_BIN\/gh"/);
  assert.match(source, /= 'go1\.27\.3'/);
  assert.ok(source.indexOf("= 'go1.27.3'") < source.indexOf('>> "$GITHUB_PATH"'));
  assert.doesNotMatch(source, /\bgh (?:api|release|auth)\b|\bsudo\b|update-ca-certificates|\|\| true/);
});
