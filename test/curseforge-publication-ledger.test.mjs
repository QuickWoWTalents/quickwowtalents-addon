import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createPublicationLedger } from '../scripts/curseforge-publication-ledger.mjs';

const token = 'fixture-github-token-never-log';
const repository = 'QuickWoWTalents/quickwowtalents-addon';
const tag = 'v1.0.155';
const branch = 'curseforge-publications';
const reserved = {
  schema: 1, status: 'reserved', tag,
  sourceCommit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64),
  projectId: 1530765, reservationId: 'fb4b532d-37b8-45da-bc79-fb81d025356a',
  createdAt: '2026-10-22T10:00:00.000Z',
};
const published = {
  ...reserved, status: 'published', fileId: 7654321, publishedAt: '2026-10-22T10:01:00.000Z',
};
const encode = (record) => Buffer.from(`${JSON.stringify(record)}\n`);
const gitSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

function contentFor(bytes, version = tag) {
  return {
    name: `${version}.json`, path: `receipts/${version}.json`, type: 'file',
    size: bytes.length, sha: gitSha(bytes),
  };
}

function writeResponse(bytes, status = 201, version = tag) {
  return json({ content: contentFor(bytes, version), commit: { sha: 'c'.repeat(40) } }, status);
}

function readResponse(record, { bytes = encode(record), version = record.tag, ...overrides } = {}) {
  return json({
    ...contentFor(bytes, version), encoding: 'base64', content: bytes.toString('base64'), ...overrides,
  });
}

function fixture({ initial, afterWrite } = {}) {
  const files = new Map(initial ? [[initial.tag, encode(initial)]] : []);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const version = parsed.pathname.match(/\/receipts\/(v\d+\.\d+\.\d+)\.json$/)?.[1];
    assert.ok(version, 'only receipt content endpoints may be used');
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.ok(parsed.pathname.startsWith(`/repos/${repository}/contents/`));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, ...options, body });
    if (options.method === 'GET') {
      assert.equal(parsed.searchParams.get('ref'), branch);
      const bytes = files.get(version);
      return bytes ? readResponse(JSON.parse(bytes), { bytes, version }) : json({ message: 'Not Found' }, 404);
    }
    assert.equal(options.method, 'PUT');
    assert.equal(parsed.search, '');
    assert.equal(body.branch, branch);
    const existing = files.get(version);
    if (existing && !Object.hasOwn(body, 'sha')) return json({ message: 'sha is required' }, 422);
    if (Object.hasOwn(body, 'sha') && (!existing || body.sha !== gitSha(existing))) {
      return json({ message: 'stale sha' }, 409);
    }
    const bytes = Buffer.from(body.content, 'base64');
    files.set(version, bytes);
    if (afterWrite) await afterWrite({ body, bytes, existing });
    return writeResponse(bytes, existing ? 200 : 201, version);
  };
  return { files, calls, fetchImpl, ledger: createPublicationLedger({ token, fetchImpl }) };
}

async function privateFailure(promise) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, /^CurseForge publication ledger failed:/);
    assert.doesNotMatch(error.stack, /fixture-github-token-never-log|server-private-secret|https:\/\/secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('claim atomically creates the version without sha and returns a verified immutable receipt', async () => {
  const f = fixture();
  const claim = await f.ledger.claim(reserved);
  assert.deepEqual(claim, { record: reserved, sha: gitSha(encode(reserved)) });
  assert.ok(Object.isFrozen(claim));
  assert.ok(Object.isFrozen(claim.record));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'PUT');
  assert.equal(Object.hasOwn(f.calls[0].body, 'sha'), false);
  assert.deepEqual(JSON.parse(f.files.get(tag)), reserved);
  assert.equal(f.calls[0].signal.aborted, true);
});

test('read distinguishes missing, reserved and published receipts and returns the actual blob sha', async () => {
  const empty = fixture();
  assert.equal(await empty.ledger.read(tag), null);
  for (const record of [reserved, published]) {
    const f = fixture({ initial: record });
    assert.deepEqual(await f.ledger.read(tag), { record, sha: gitSha(encode(record)) });
    assert.equal(f.calls.length, 1);
  }
  // Bootstrap/reconciliation may use formatted JSON; the hash is over its exact bytes.
  const bytes = Buffer.from(`${JSON.stringify(reserved, null, 2)}\n`);
  const ledger = createPublicationLedger({ token, fetchImpl: async () => readResponse(reserved, { bytes }) });
  assert.equal((await ledger.read(tag)).sha, gitSha(bytes));
});

test('existing reservations and published versions cannot be claimed again', async () => {
  for (const initial of [reserved, published]) {
    const f = fixture({ initial });
    await privateFailure(f.ledger.claim({ ...reserved, reservationId: 'bb4b532d-37b8-45da-bc79-fb81d025356a' }));
    assert.deepEqual(JSON.parse(f.files.get(tag)), initial);
    assert.equal(f.calls.length, 1);
    assert.equal(Object.hasOwn(f.calls[0].body, 'sha'), false);
  }
});

test('concurrent claimants get exactly one successful claim without overwriting the winner', async () => {
  const f = fixture();
  const second = createPublicationLedger({ token, fetchImpl: f.fetchImpl });
  const contender = { ...reserved, reservationId: 'bb4b532d-37b8-45da-bc79-fb81d025356a' };
  const results = await Promise.allSettled([f.ledger.claim(reserved), second.claim(contender)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.deepEqual(JSON.parse(f.files.get(tag)), results.find((r) => r.status === 'fulfilled').value.record);
  assert.equal(f.calls.length, 2);
});

test('lost response after a successful remote create never authorizes an upload or retries', async () => {
  const f = fixture({ afterWrite: () => { throw new Error(`${token} server-private-secret https://private.test`); } });
  await privateFailure(f.ledger.claim(reserved));
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.ledger.read(tag)).record, reserved);
  await privateFailure(f.ledger.claim(reserved));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(JSON.parse(f.files.get(tag)), reserved);
});

test('completion uses the exact verified prior blob sha and preserves reservation identity', async () => {
  const f = fixture();
  const claim = await f.ledger.claim(reserved);
  const completed = await f.ledger.complete(claim, published);
  assert.deepEqual(completed, { record: published, sha: gitSha(encode(published)) });
  assert.equal(f.calls[1].body.sha, claim.sha);
  assert.deepEqual(JSON.parse(f.files.get(tag)), published);
  await privateFailure(f.ledger.complete(completed, published));
  assert.equal(f.calls.length, 2);
});

test('completion can reconcile a verified read reservation without rewriting its original byte identity', async () => {
  const f = fixture({ initial: reserved });
  const bytes = Buffer.from(JSON.stringify(reserved, null, 2));
  f.files.set(tag, bytes);
  const claim = await f.ledger.read(tag);
  await f.ledger.complete(claim, published);
  assert.equal(f.calls[1].body.sha, gitSha(bytes));
});

test('stale completion conflicts without replacing another completion or retrying', async () => {
  const f = fixture({ initial: reserved });
  const claim = await f.ledger.read(tag);
  const existing = { ...published, fileId: published.fileId + 1 };
  f.files.set(tag, encode(existing));
  await privateFailure(f.ledger.complete(claim, published));
  assert.deepEqual(JSON.parse(f.files.get(tag)), existing);
  assert.equal(f.calls.length, 2);
});

test('a lost completion response leaves its published receipt durable and fails closed', async () => {
  const f = fixture({
    initial: reserved, afterWrite: () => { throw new Error('server-private-secret'); },
  });
  const claim = await f.ledger.read(tag);
  await privateFailure(f.ledger.complete(claim, published));
  assert.equal(f.calls.length, 2);
  assert.deepEqual((await f.ledger.read(tag)).record, published);
  await privateFailure(f.ledger.claim(reserved));
});

test('completion rejects forged handles and identity mismatches before any write', async () => {
  const f = fixture({ initial: reserved });
  const claim = await f.ledger.read(tag);
  await privateFailure(f.ledger.complete({ ...claim }, published));
  const other = createPublicationLedger({ token, fetchImpl: f.fetchImpl });
  await privateFailure(other.complete(claim, published));
  for (const patch of [
    { tag: 'v1.0.156' }, { sourceCommit: 'd'.repeat(40) }, { archiveSha256: 'e'.repeat(64) },
    { reservationId: 'bb4b532d-37b8-45da-bc79-fb81d025356a' }, { createdAt: '2026-10-22T09:00:00.000Z' },
    { projectId: 999 }, { status: 'reserved' }, { fileId: 0 }, { fileId: 1.5 },
    { publishedAt: '2026-10-22T09:59:59.000Z' },
  ]) await privateFailure(f.ledger.complete(claim, { ...published, ...patch }));
  assert.equal(f.calls.length, 1);
});

test('read returns null only for exact404, never for JSON null or other ambiguous statuses', async () => {
  for (const status of [200, 201, 202, 204, 301, 302, 304, 401, 403, 409, 422, 429, 500, 503]) {
    let calls = 0;
    const ledger = createPublicationLedger({ token, fetchImpl: async () => {
      calls += 1;
      return new Response([204, 304].includes(status) ? null : 'null', {
        status, headers: { 'content-type': 'application/json' },
      });
    } });
    await privateFailure(ledger.read(tag));
    assert.equal(calls, 1);
  }
  const ledger = createPublicationLedger({ token, fetchImpl: async () => new Response('not JSON', { status: 404 }) });
  assert.equal(await ledger.read(tag), null);
});

test('write status must be201 for a claim and200 for completion', async () => {
  for (const status of [200, 202, 400, 403, 404, 409, 422, 429, 500]) {
    let calls = 0;
    const ledger = createPublicationLedger({ token, fetchImpl: async () => {
      calls += 1; return writeResponse(encode(reserved), status);
    } });
    await privateFailure(ledger.claim(reserved));
    assert.equal(calls, 1);
  }
  const ledger = createPublicationLedger({ token, fetchImpl: async (url, options) => options.method === 'GET'
    ? readResponse(reserved) : writeResponse(encode(published), 201) });
  await privateFailure(ledger.complete(await ledger.read(tag), published));
});

test('successful status with wrong blob, path, name, size or commit is not a verified claim', async () => {
  for (const patch of [
    { sha: 'f'.repeat(40) }, { path: 'receipts/v1.0.156.json' }, { name: 'v1.0.156.json' },
    { size: 1 }, { type: 'symlink' }, { target: 'other.json' }, { submodule_git_url: 'https://private.test' },
  ]) {
    const ledger = createPublicationLedger({ token, fetchImpl: async () => json({
      content: { ...contentFor(encode(reserved)), ...patch }, commit: { sha: 'c'.repeat(40) },
    }, 201) });
    await privateFailure(ledger.claim(reserved));
  }
  for (const result of [null, [], {}, { content: null, commit: {} }, {
    content: contentFor(encode(reserved)), commit: { sha: 'bad' },
  }, { content: contentFor(encode(reserved)), commit: { sha: 'c'.repeat(40) }, unknown: true }]) {
    const ledger = createPublicationLedger({ token, fetchImpl: async () => json(result, 201) });
    await privateFailure(ledger.claim(reserved));
  }
});

test('existing receipt must have valid encoding, exact blob bytes, schema and requested tag', async () => {
  for (const patch of [
    { encoding: 'none' }, { content: '%%%' }, { content: 'YQ' },
    { content: encode(reserved).toString('base64') + ' ' },
    { sha: 'f'.repeat(40) }, { size: 4097 }, { type: 'dir' },
  ]) {
    const ledger = createPublicationLedger({ token, fetchImpl: async () => readResponse(reserved, patch) });
    await privateFailure(ledger.read(tag));
  }
  for (const record of [
    { ...reserved, schema: 2 }, { ...reserved, projectId: 1 }, { ...reserved, secret: 'server-private-secret' },
    { ...reserved, tag: 'v1.0.156' }, { ...published, fileId: -1 },
  ]) {
    const ledger = createPublicationLedger({ token, fetchImpl: async () => readResponse(record, { version: tag }) });
    await privateFailure(ledger.read(tag));
  }
  const bytes = Buffer.from([0xff, 0xfe]);
  const ledger = createPublicationLedger({ token, fetchImpl: async () => readResponse(reserved, { bytes }) });
  await privateFailure(ledger.read(tag));
});

test('GitHub base64 line wrapping is accepted without relaxing byte or record checks', async () => {
  const encoded = encode(reserved).toString('base64').match(/.{1,60}/g).join('\n') + '\n';
  const ledger = createPublicationLedger({ token, fetchImpl: async () => readResponse(reserved, { content: encoded }) });
  assert.deepEqual((await ledger.read(tag)).record, reserved);
});

test('invalid records and tags fail before network access, without evaluating accessors', async () => {
  let calls = 0;
  const ledger = createPublicationLedger({ token, fetchImpl: async () => { calls += 1; throw new Error('unexpected'); } });
  for (const patch of [
    { schema: '1' }, { status: 'published' }, { sourceCommit: 'A'.repeat(40) },
    { sourceCommit: 'not-a-sha' }, { archiveSha256: 'b'.repeat(63) }, { projectId: '1530765' },
    { reservationId: 'not-a-uuid' }, { createdAt: '2026-02-30T10:00:00.000Z' },
    { createdAt: '2026-10-22T10:00:00+00:00' }, { unexpected: 'server-private-secret' },
  ]) await privateFailure(ledger.claim({ ...reserved, ...patch }));
  for (const version of ['../main', 'v01.0.0', 'v1.0.1-beta', 'v1.0.1?ref=main', `v${'9'.repeat(65)}.0.0`, null]) {
    await privateFailure(ledger.read(version));
    await privateFailure(ledger.claim({ ...reserved, tag: version }));
  }
  for (const field of ['status', 'tag', 'createdAt']) {
    const record = { ...reserved };
    Object.defineProperty(record, field, { enumerable: true, get() { assert.fail('accessor evaluated'); } });
    await privateFailure(ledger.claim(record));
  }
  await privateFailure(ledger.claim(Object.assign(Object.create({ inherited: true }), reserved)));
  assert.equal(calls, 0);
});

test('invalid configuration cannot redirect a token to another origin or inject headers', () => {
  for (const options of [
    { token: undefined }, { token: '' }, { token: 'secret\r\nHeader: value' },
    { repository: 'https://private.test' }, { repository: '../addon' }, { repository: 'owner/repo?x=y' },
    { repository: 'owner/repo/extra' }, { fetchImpl: null },
  ]) assert.throws(() => createPublicationLedger({ token, ...options }), /^Error: CurseForge publication ledger failed:/);
});

test('redirects, fetch exceptions and malformed JSON fail without exposing remote bodies or credentials', async () => {
  const handlers = [
    async () => { throw new Error(`${token} server-private-secret https://private.test`); },
    async () => new Response('server-private-secret', { status: 500 }),
    async () => new Response('server-private-secret', { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => {
      const response = writeResponse(encode(reserved));
      Object.defineProperty(response, 'redirected', { value: true }); return response;
    },
    async () => {
      const response = writeResponse(encode(reserved));
      Object.defineProperty(response, 'url', { value: 'https://private.test' }); return response;
    },
  ];
  for (const fetchImpl of handlers) await privateFailure(createPublicationLedger({ token, fetchImpl }).claim(reserved));
});

test('bounded responses reject oversized streaming bodies, invalid types and inconsistent lengths', async () => {
  const wrongType = writeResponse(encode(reserved));
  wrongType.headers.set('content-type', 'text/html');
  for (const response of [
    new Response('x'.repeat(32769), { status: 201, headers: { 'content-type': 'application/json' } }),
    wrongType,
    json({}, 201, { 'content-length': '32769' }),
    json({}, 201, { 'content-length': 'invalid' }),
    json({}, 201, { 'content-length': '3' }),
    json({}, 201, { 'content-encoding': 'unknown' }),
  ]) {
    const ledger = createPublicationLedger({ token, fetchImpl: async () => response });
    await privateFailure(ledger.claim(reserved));
  }
});

test('auto-decompressed GitHub responses retain a compressed length while decoded bytes remain bounded', async () => {
  const body = JSON.stringify({ content: contentFor(encode(reserved)), commit: { sha: 'c'.repeat(40) } });
  const compressed = gzipSync(body);
  assert.notEqual(compressed.length, Buffer.byteLength(body));
  const ledger = createPublicationLedger({ token, fetchImpl: async () => new Response(body, {
    status: 201, headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(compressed.length),
    },
  }) });
  assert.deepEqual((await ledger.claim(reserved)).record, reserved);
  const oversized = 'x'.repeat(32769);
  const failing = createPublicationLedger({ token, fetchImpl: async () => new Response(oversized, {
    status: 201, headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gzipSync(oversized).length),
    },
  }) });
  await privateFailure(failing.claim(reserved));
});

test('the 30-second deadline covers both headers and body stalls and performs no retry', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  for (const phase of ['headers', 'body']) {
    let calls = 0;
    let signal;
    let installedDeadline;
    const restore = t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
      installedDeadline = milliseconds;
      return realSetTimeout(callback, 5, ...args);
    });
    const ledger = createPublicationLedger({ token, fetchImpl: async (url, options) => {
      calls += 1; signal = options.signal;
      if (phase === 'headers') return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    } });
    await privateFailure(ledger.claim(reserved));
    assert.equal(installedDeadline, 30_000);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    restore.mock.restore();
  }
});
