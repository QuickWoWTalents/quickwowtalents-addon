import assert from 'node:assert/strict';
import test from 'node:test';
import { findDailyPublication, pacificDay } from '../scripts/check-daily-publication.mjs';

const repository = 'owner/addon';
const baseHead = 'b'.repeat(40);
const sourceHead = 'a'.repeat(40);
const now = new Date('2026-10-21T15:00:00Z');
const root = `repos/${repository}/actions`;
const stepName = 'Publish or reconcile verified release';

function run(overrides = {}) {
  return {
    id: 100, run_attempt: 1, path: '.github/workflows/daily-release.yml',
    repository: { full_name: repository }, head_sha: sourceHead, head_branch: 'main',
    event: 'repository_dispatch', status: 'completed', conclusion: 'success',
    created_at: '2026-10-20T22:00:00Z', updated_at: '2026-10-21T14:00:00Z',
    ...overrides
  };
}
function job(overrides = {}, step = {}) {
  return {
    id: 200, run_id: 100, run_attempt: 1, status: 'completed', conclusion: 'success',
    steps: [{ name: stepName, status: 'completed', conclusion: 'success', completed_at: '2026-10-21T13:00:00Z', ...step }],
    ...overrides
  };
}
function fixture({ runs = [run()], jobs = { '100/1': [job()] }, attempts = {}, ...options } = {}) {
  const calls = [];
  const ancestry = [];
  const readApi = async (endpoint) => {
    calls.push(endpoint);
    const [pathname, search] = endpoint.split('?');
    const params = new URLSearchParams(search);
    const page = Number(params.get('page'));
    const size = Number(params.get('per_page'));
    let values, field;
    if (pathname === `${root}/workflows/daily-release.yml/runs`) {
      values = runs; field = 'workflow_runs';
    } else {
      const match = pathname.match(/\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/);
      assert.ok(match, `unexpected API endpoint ${endpoint}`);
      const key = `${match[1]}/${match[2]}`;
      if (!match[3]) {
        assert.ok(attempts[key], `missing attempt fixture ${key}`);
        return attempts[key];
      }
      assert.ok(jobs[key], `missing jobs fixture ${key}`);
      values = jobs[key]; field = 'jobs';
    }
    return { total_count: values.length, [field]: values.slice((page - 1) * size, page * size) };
  };
  return {
    calls, ancestry,
    check: (overrides = {}) => findDailyPublication({
      repository, currentRunId: 500, currentRunAttempt: 1, baseHead, now, readApi,
      isAncestor: async (...args) => { ancestry.push(args); return true; },
      ...options, ...overrides
    })
  };
}

test('verified publication consumes its Pacific day despite refreshed data or old run creation', async () => {
  const f = fixture();
  assert.deepEqual(await f.check(), {
    alreadyPublished: true, dayKey: '2026-10-21', runId: 100, runAttempt: 1,
    publishedAt: '2026-10-21T13:00:00Z', sourceHead
  });
  assert.deepEqual(f.ancestry, [[sourceHead, baseHead]]);
});

test('Pacific day uses publication completion, including midnight and daylight saving boundaries', async () => {
  assert.equal(pacificDay('2026-10-21T06:59:59Z'), '2026-10-20');
  assert.equal(pacificDay('2026-10-21T07:00:00Z'), '2026-10-21');
  assert.equal(pacificDay('2026-11-01T08:59:59Z'), '2026-11-01');
  assert.equal(pacificDay('2026-11-01T09:00:00Z'), '2026-11-01');
  const f = fixture({ jobs: { '100/1': [job({}, { completed_at: '2026-10-21T06:59:59Z' })] } });
  assert.equal((await f.check()).alreadyPublished, false);
  const crossing = fixture({ jobs: { '100/1': [job({}, { completed_at: '2026-10-21T07:00:00Z' })] } });
  assert.equal((await crossing.check()).alreadyPublished, true);
});

test('current run, non-main and unrelated events cannot prove publication', async () => {
  for (const overrides of [{ id: 500 }, { head_branch: 'feature' }, { event: 'pull_request' }]) {
    const f = fixture({ runs: [run(overrides)] });
    assert.equal((await f.check()).alreadyPublished, false);
    assert.equal(f.calls.length, 1);
  }
});

test('manual publication counts, while successful dry-run/no-op and failed draft publication do not', async () => {
  assert.equal((await fixture({ runs: [run({ event: 'workflow_dispatch' })] }).check()).alreadyPublished, true);
  for (const step of [{ conclusion: 'skipped' }, { conclusion: 'failure' }]) {
    assert.equal((await fixture({ jobs: { '100/1': [job({}, step)] } }).check()).alreadyPublished, false);
  }
  assert.equal((await fixture({ jobs: { '100/1': [job({ steps: [] })] } }).check()).alreadyPublished, false);
  const failed = fixture({ runs: [run({ conclusion: 'failure' })], jobs: { '100/1': [job({ conclusion: 'failure' }, { conclusion: 'failure' })] } });
  assert.equal((await failed.check()).alreadyPublished, false);
  assert.equal(failed.calls.length, 2);
});

test('later failed rerun does not hide an earlier successful publication attempt', async () => {
  const f = fixture({
    runs: [run({ run_attempt: 2, conclusion: 'failure' })],
    attempts: { '100/1': run() }, jobs: { '100/1': [job()], '100/2': [job({ run_attempt: 2, conclusion: 'failure' }, { conclusion: 'failure' })] }
  });
  const proof = await f.check();
  assert.equal(proof.alreadyPublished, true);
  assert.equal(proof.runAttempt, 1);
  assert.ok(f.calls.includes(`${root}/runs/100/attempts/1`));
});

test('publication proof must belong to the same source history', async () => {
  assert.equal((await fixture().check({ isAncestor: async () => false })).alreadyPublished, false);
  await assert.rejects(fixture().check({ isAncestor: async () => { throw new Error('missing source'); } }), /missing source/);
});

test('run and job pagination are exhausted before declaring no publication', async () => {
  const f = fixture({
    pageSize: 1,
    runs: [run({ id: 101, updated_at: '2026-10-20T14:00:00Z' }), run()],
    jobs: { '100/1': [job({ id: 201, steps: [] }), job()] }
  });
  assert.equal((await f.check()).alreadyPublished, true);
  assert.ok(f.calls.includes(`${root}/workflows/daily-release.yml/runs?per_page=1&page=2`));
  assert.ok(f.calls.includes(`${root}/runs/100/attempts/1/jobs?per_page=1&page=2`));
  const empty = fixture({ runs: [] });
  assert.deepEqual(await empty.check(), { alreadyPublished: false, dayKey: '2026-10-21' });
});

test('API failures, malformed or truncated pagination fail closed', async () => {
  for (const response of [
    {}, { total_count: 1, workflow_runs: [] }, { total_count: -1, workflow_runs: [] },
    { total_count: 1, workflow_runs: [run({ repository: { full_name: 'other/addon' } })] }
  ]) {
    await assert.rejects(fixture().check({ readApi: async () => response }), /Daily publication check failed/);
  }
  await assert.rejects(fixture().check({ readApi: async () => { throw new Error('API unavailable'); } }), /API unavailable/);
  const tooMany = fixture({ pageSize: 1, maxRunPages: 1, runs: [
    run({ id: 101, updated_at: '2026-10-20T14:00:00Z' }), run()
  ] });
  await assert.rejects(tooMany.check(), /bounded pagination/);
  await assert.rejects(fixture({ pageSize: 1, maxJobPages: 1, jobs: {
    '100/1': [job({ id: 201, steps: [] }), job()]
  } }).check(), /bounded pagination/);
});

test('changed totals, repeated entries and excessive reruns fail closed', async () => {
  let count = 0;
  await assert.rejects(fixture().check({
    pageSize: 1, readApi: async () => ({
      total_count: ++count === 1 ? 2 : 3,
      workflow_runs: [run({ id: count, updated_at: '2026-10-20T14:00:00Z' })]
    })
  }), /changed during pagination/);
  await assert.rejects(fixture({ pageSize: 1, runs: [
    run({ updated_at: '2026-10-20T14:00:00Z' }), run({ updated_at: '2026-10-20T14:00:00Z' })
  ] }).check(), /repeated/);
  await assert.rejects(fixture({
    maxAttempts: 1, runs: [run({ run_attempt: 2, conclusion: 'failure' })],
    jobs: { '100/2': [job({ run_attempt: 2 }, { conclusion: 'failure' })] }
  }).check(), /attempts exceed/);
});

test('unsettled earlier main runs, invalid jobs and future publication proof fail closed', async () => {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    await assert.rejects(fixture({ runs: [run({ status, conclusion: null })] }).check(), /not settled/);
  }
  for (const invalidJob of [
    job({ run_id: 999 }), job({ run_attempt: 2 }),
    job({ steps: [job().steps[0], job().steps[0]] }),
    job({}, { completed_at: 'not-a-time' }),
    job({}, { completed_at: '2026-10-22T13:00:00Z' })
  ]) {
    await assert.rejects(fixture({ jobs: { '100/1': [invalidJob] } }).check(), /Daily publication check failed/);
  }
});

test('an executing rerun excludes only its current attempt, retaining earlier publication proof', async () => {
  const f = fixture({
    runs: [run({ id: 500, run_attempt: 2, status: 'in_progress', conclusion: null })],
    attempts: { '500/1': run({ id: 500 }) },
    jobs: { '500/1': [job({ run_id: 500 })] }
  });
  assert.equal((await f.check({ currentRunAttempt: 2 })).alreadyPublished, true);
  assert.ok(!f.calls.some((url) => url.includes('/attempts/2/jobs')));
});

test('successful publication still counts after later job or workflow bookkeeping fails', async () => {
  const f = fixture({
    runs: [run({ conclusion: 'failure' })],
    jobs: { '100/1': [job({ conclusion: 'failure' })] }
  });
  assert.equal((await f.check()).alreadyPublished, true);
});
