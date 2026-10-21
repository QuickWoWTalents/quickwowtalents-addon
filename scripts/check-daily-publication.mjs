#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const WORKFLOW_PATH = '.github/workflows/daily-release.yml';
const PUBLICATION_STEP = 'Publish or reconcile verified release';
const PAGE_SIZE = 100;
const MAX_RUN_PAGES = 50;
const MAX_JOB_PAGES = 10;
const MAX_ATTEMPTS = 10;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(message) {
  throw new Error(`Daily publication check failed: ${message}`);
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail(`invalid ${label}.`);
  return Date.parse(value);
}

export function pacificDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid check time.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name).value).join('-');
}

async function githubApi(endpoint) {
  try {
    const { stdout } = await execFileAsync('gh', [
      'api', '--method', 'GET', '--hostname', 'github.com',
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      '-H', 'Cache-Control: no-cache', endpoint
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    // Do not turn unavailable or malformed API history into permission to publish.
    fail('GitHub Actions history could not be read.');
  }
}

async function ancestor(head, base) {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', head, base], { timeout: 10_000 });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    fail('prior workflow source ancestry could not be verified.');
  }
}

async function* pages(readApi, endpoint, field, limit, pageSize) {
  let total = null;
  const seen = new Set();
  for (let page = 1; page <= limit; page += 1) {
    const result = await readApi(`${endpoint}?per_page=${pageSize}&page=${page}`);
    if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0
      || !Array.isArray(result[field])) fail('malformed paginated Actions history.');
    if (total !== null && total !== result.total_count) fail('Actions history changed during pagination.');
    total = result.total_count;
    const expected = Math.min(pageSize, total - seen.size);
    if (result[field].length !== expected) fail('incomplete paginated Actions history.');
    for (const item of result[field]) {
      if (!Number.isSafeInteger(item?.id) || item.id <= 0 || seen.has(item.id)) fail('invalid or repeated Actions history entry.');
      seen.add(item.id);
      yield item;
    }
    if (seen.size === total) return;
  }
  fail('Actions history exceeds the bounded pagination limit.');
}

function validateRun(run, repository, expectedId = run?.id, expectedAttempt = run?.run_attempt) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 || run.id !== expectedId
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt !== expectedAttempt
    || run.repository?.full_name !== repository || run.path !== WORKFLOW_PATH
    || !SHA.test(run.head_sha ?? '')
    || !['completed', 'in_progress', 'queued', 'waiting', 'pending', 'requested'].includes(run.status)
    || (run.head_branch !== null && typeof run.head_branch !== 'string')
    || typeof run.event !== 'string') fail('invalid workflow identity or attempt.');
  timestamp(run.updated_at, 'workflow update time');
}

export async function findDailyPublication({
  repository, currentRunId, currentRunAttempt, baseHead, now = new Date(),
  readApi = githubApi, isAncestor = ancestor,
  pageSize = PAGE_SIZE, maxRunPages = MAX_RUN_PAGES,
  maxJobPages = MAX_JOB_PAGES, maxAttempts = MAX_ATTEMPTS
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')
    || !Number.isSafeInteger(currentRunId) || currentRunId <= 0
    || !Number.isSafeInteger(currentRunAttempt) || currentRunAttempt < 1 || !SHA.test(baseHead ?? '')) {
    fail('repository, current run ID/attempt, and checkout HEAD are required.');
  }
  for (const limit of [pageSize, maxRunPages, maxJobPages, maxAttempts]) {
    if (!Number.isSafeInteger(limit) || limit < 1) fail('invalid history bound.');
  }
  const dayKey = pacificDay(now);
  const checkedAt = new Date(now).getTime();
  const root = `repos/${repository}/actions`;
  // Scan bounded complete history, not a created_at cutoff: queued runs and
  // reruns can publish today even when their original run was created earlier.
  for await (const run of pages(readApi, `${root}/workflows/daily-release.yml/runs`, 'workflow_runs', maxRunPages, pageSize)) {
    validateRun(run, repository);
    if (run.id === currentRunId && run.run_attempt > currentRunAttempt) fail('Actions history is newer than the executing workflow attempt.');
    if (run.head_branch !== 'main'
      || !['repository_dispatch', 'workflow_dispatch'].includes(run.event)) continue;
    if (run.id < currentRunId && ['in_progress', 'queued', 'waiting', 'pending', 'requested'].includes(run.status)) {
      fail('an earlier main release run has not settled.');
    }
    if (pacificDay(run.updated_at) < dayKey) continue;
    // A later failed rerun must not hide an earlier successful publication.
    const lastAttempt = run.id === currentRunId ? Math.min(run.run_attempt, currentRunAttempt - 1) : run.run_attempt;
    for (let attempt = lastAttempt, checked = 0; attempt >= 1; attempt -= 1, checked += 1) {
      if (checked >= maxAttempts) fail('workflow attempts exceed the bounded history limit.');
      const record = attempt === run.run_attempt ? run : await readApi(`${root}/runs/${run.id}/attempts/${attempt}`);
      validateRun(record, repository, run.id, attempt);
      if (record.head_sha !== run.head_sha || record.head_branch !== 'main') fail('workflow attempt source changed.');
      if (record.status !== 'completed') continue;
      let proof = null;
      for await (const job of pages(readApi, `${root}/runs/${run.id}/attempts/${attempt}/jobs`, 'jobs', maxJobPages, pageSize)) {
        if (job.run_id !== run.id || job.run_attempt !== attempt || !Array.isArray(job.steps)) fail('invalid workflow job identity.');
        const matches = job.steps.filter((step) => step.name === PUBLICATION_STEP);
        if (matches.length > 1) fail('ambiguous publication step.');
        const step = matches[0];
        // A successful publisher already verified the public asset, even if a
        // later cleanup step failed. A failed/skipped publisher is never proof.
        if (!step || job.status !== 'completed'
          || step.status !== 'completed' || step.conclusion !== 'success') continue;
        const completed = timestamp(step.completed_at, 'publication completion time');
        if (completed > checkedAt) fail('publication completion is in the future.');
        if (pacificDay(completed) !== dayKey) continue;
        if (proof) fail('ambiguous publication jobs.');
        proof = { runId: run.id, runAttempt: attempt, publishedAt: step.completed_at, sourceHead: record.head_sha };
      }
      if (proof && await isAncestor(record.head_sha, baseHead)) {
        return { alreadyPublished: true, dayKey, ...proof };
      }
    }
  }
  return { alreadyPublished: false, dayKey };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await findDailyPublication({
      repository: process.env.GITHUB_REPOSITORY,
      currentRunId: Number(process.env.GITHUB_RUN_ID),
      currentRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      baseHead: process.env.BASE_HEAD
    });
    if (result.alreadyPublished) {
      console.error(`Verified prior publication for ${result.dayKey}: run ${result.runId}, attempt ${result.runAttempt}, completed ${result.publishedAt}.`);
    }
    console.log(result.alreadyPublished ? 'already-published' : 'not-published');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
