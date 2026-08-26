import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflows = [
  ['pull request', new URL('../.github/workflows/pull-request.yml', import.meta.url)],
  ['daily release', new URL('../.github/workflows/daily-release.yml', import.meta.url)]
];

for (const [name, workflowUrl] of workflows) {
  test(`${name} workflow installs locked dependencies before repository scripts`, async () => {
    const source = await readFile(workflowUrl, 'utf8');
    const setupNodeIndex = source.indexOf('uses: actions/setup-node@v4');
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
