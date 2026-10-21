import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
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
    assert.match(bootstrap.run, /\[ "\$\{GIT_SSL_NO_VERIFY\+x\}" != x \]/);
    assert.doesNotMatch(bootstrap.run, /GIT_SSL_NO_VERIFY=/);
    assert.match(bootstrap.run, /https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-x64\.tar\.xz/);
    assert.match(bootstrap.run, /6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6/);
    assert.match(bootstrap.run, /sha256sum --check --status/);
    assert.ok(bootstrap.run.indexOf('sha256sum --check --status') < bootstrap.run.indexOf('tar -xJf'));
    assert.ok(bootstrap.run.indexOf('sha256sum --check --status') < bootstrap.run.indexOf("import { rootCertificates }"));
    assert.match(bootstrap.run, /GIT_SSL_CAINFO=\$\{bundlePath\}/);
    assert.match(bootstrap.run, /GIT_SSL_CAPATH=\$\{emptyPath\}/);
    assert.match(bootstrap.run, /mkdir -m 700 "\$CA_EMPTY_PATH"/);
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
  assert.match(source, /--cacert "\$GIT_SSL_CAINFO" --capath "\$GIT_SSL_CAPATH"/);
  assert.match(source, /find "\$GIT_SSL_CAPATH" -mindepth 1 -print -quit/);
  assert.match(source, /\[ "\$\{GIT_SSL_NO_VERIFY\+x\}" != x \]/);
  assert.doesNotMatch(source, /GIT_SSL_NO_VERIFY=/);
  assert.doesNotMatch(source, /\bgh (?:api|release|auth)\b|\bsudo\b|update-ca-certificates|\|\| true/);
});

async function bootstrapProgram() {
  const workflow = parseDocument(await readFile(workflows[0][1], 'utf8')).toJS();
  return Object.values(workflow.jobs)[0].steps[0].run;
}

test('hosted bootstrap rejects every defined Git TLS bypass value before network or writes', async () => {
  // Git 2.55.0 http.c checks getenv presence, so even "false" disables verification.
  const prefix = (await bootstrapProgram()).split('RUNTIME_DIR=')[0];
  const env = { ...process.env, RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  delete env.ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION;
  delete env.GIT_SSL_NO_VERIFY;
  assert.equal(spawnSync('bash', ['-c', prefix], { env, encoding: 'utf8' }).status, 0);
  for (const value of ['', 'false', 'true']) {
    const result = spawnSync('bash', ['-c', prefix], { env: { ...env, GIT_SSL_NO_VERIFY: value }, encoding: 'utf8' });
    assert.equal(result.status, 1, `GIT_SSL_NO_VERIFY=${JSON.stringify(value)} must be rejected`);
  }
});

test('pre-checkout CA exporter writes only the pinned bundled roots and task-specific trust paths', async () => {
  const source = (await bootstrapProgram()).match(/<<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
  assert.ok(source, 'pre-checkout CA exporter must be present');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qwt-ca-export-'));
  try {
    const bundlePath = path.join(directory, 'bundle.pem');
    const emptyPath = path.join(directory, 'empty-ca');
    const envPath = path.join(directory, 'github-env');
    const result = spawnSync(process.execPath, ['--input-type=module', '-', bundlePath, emptyPath, envPath], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const bundle = await readFile(bundlePath, 'utf8');
    assert.equal(createHash('sha256').update(bundle).digest('hex'), '15783a17671365196e5e4ba6ddea3132df72538fef70be91bbd91f45c85c170f');
    const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    assert.equal(certificates.length, 118);
    assert.ok(certificates.every((pem) => !/emSign (?:ECC Root|Root TLS) CA - G3|AAA Certificate Services/.test(new X509Certificate(pem).subject)));
    const env = Object.fromEntries((await readFile(envPath, 'utf8')).trim().split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.deepEqual(env, {
      GIT_SSL_CAINFO: bundlePath, GIT_SSL_CAPATH: emptyPath,
      CURL_CA_BUNDLE: bundlePath, SSL_CERT_FILE: bundlePath, SSL_CERT_DIR: emptyPath,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CA exporter rejects a real distrusted root and unrecognized bundle bytes before publishing trust', async () => {
  const source = (await bootstrapProgram()).match(/<<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
  assert.ok(source);
  // Public certificate from nodejs/node v24.22.0 src/node_root_certs.h.
  const rejectedRoot = await readFile(new URL('./fixtures/emsign-ecc-g3.pem', import.meta.url), 'utf8');
  assert.equal(new X509Certificate(rejectedRoot).fingerprint256.replaceAll(':', ''), '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B');
  for (const [replacement, error] of [
    [JSON.stringify(rejectedRoot), /Distrusted CA subject/],
    ['bundledRoots[0]', /Unexpected pinned Node CA bundle/],
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'qwt-ca-reject-'));
    try {
      const injected = source.replace("import { rootCertificates } from 'node:tls';", `import { rootCertificates as bundledRoots } from 'node:tls';\nconst rootCertificates = [...bundledRoots.slice(0, -1), ${replacement}];`);
      const result = spawnSync(process.execPath, ['--input-type=module', '-', path.join(directory, 'bundle.pem'), path.join(directory, 'empty-ca'), path.join(directory, 'github-env')], { input: injected, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, error);
      assert.deepEqual(await readdir(directory), [], 'rejected roots must not create a bundle or publish environment values');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
