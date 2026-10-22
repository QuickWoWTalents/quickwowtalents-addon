import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  parseSupportedGameVersions, prepareCurseForgeUpload, uploadCurseForge,
} from '../scripts/curseforge-upload.mjs';

const TOKEN = 'test-token-never-echo';
const TOC = '## Interface: 120105, 120100, 120007, 120005, 120001, 120000, 110200\n## OptionalDeps: EllesmereUI\n';
const VERSIONS = ['12.1.5', '12.1.0', '12.0.7', '12.0.5', '12.0.1', '12.0.0', '11.2.0'];
const IDS = [16984, 16519, 16238, 15855, 14422, 13924, 13433];
const CATALOG = VERSIONS.map((name, index) => ({
  name, id: IDS[index], gameVersionTypeID: 517,
  apiVersion: String(name.split('.').map(Number).reduce((value, part) => value * 100 + part, 0)),
}));
const BYTES = Buffer.from('immutable artifact already semantically verified by the release publisher');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value, options) => new Response(JSON.stringify(value), options);

async function prepare(overrides = {}) {
  return prepareCurseForgeUpload({
    tag: 'v1.0.156', tocText: TOC, changelog: '## Version 1.0.156\n\n- Refresh data.',
    archiveBytes: BYTES, expectedSha256: digest(BYTES), token: TOKEN,
    fetchImpl: async () => json(CATALOG), ...overrides,
  });
}

function isPreparationError(error) {
  assert.equal(error.code, 'CURSEFORGE_PREPARATION_FAILED');
  assert.equal(error.ambiguous, undefined);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /test-token|private|secret-response/);
  return true;
}

function isAmbiguousError(error) {
  assert.equal(error.code, 'CURSEFORGE_UPLOAD_AMBIGUOUS');
  assert.equal(error.ambiguous, true);
  assert.equal(error.cause, undefined);
  assert.equal(error.message, 'CurseForge upload outcome is unknown; do not retry automatically.');
  return true;
}

test('TOC parser preserves all supported Retail versions, including the real current TOC', async () => {
  assert.deepEqual(parseSupportedGameVersions(TOC), VERSIONS);
  assert.deepEqual(parseSupportedGameVersions(TOC.replaceAll('\n', '\r\n')), VERSIONS);
  const actual = await fs.readFile(new URL('../QuickWoWTalents.toc', import.meta.url), 'utf8');
  assert.deepEqual(parseSupportedGameVersions(actual), VERSIONS);
});

test('TOC parser rejects missing, duplicated, malformed and ambiguous declarations', () => {
  for (const tocText of [
    '', '## Version: 1.0.0', `${TOC}## Interface: 120105`,
    `${TOC}  ## Interface: 120105`, `${TOC}## interface: 120105`,
    '## Interface: 120105, 120105', '## Interface: 120105,',
    '## Interface: 120105 extra', '## Interface: 0120105',
    '## Interface: 12.1.5', '## Interface: 120105\0',
  ]) assert.throws(() => parseSupportedGameVersions(tocText), isPreparationError);
});

test('preparation uses only a bounded authenticated Retail metadata GET and no upload', async () => {
  const calls = [];
  const prepared = await prepare({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json([...CATALOG, { name: '12.1.5', id: 90000, gameVersionTypeID: 999 }]);
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://wow.curseforge.com/api/game/versions');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['X-Api-Token'], TOKEN);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(prepared.metadata, {
    displayName: 'v1.0.156', releaseType: 'release', changelogType: 'markdown',
    changelog: '## Version 1.0.156\n\n- Refresh data.', gameVersions: IDS,
  });
  assert.equal(prepared.metadata.relations, undefined);
  assert.equal(prepared.token, undefined);
  assert.ok(prepared.archiveBytes instanceof Blob);
});

test('metadata resolution fails closed for missing, duplicate, wrong-type or inconsistent versions', async () => {
  const cases = [
    {}, [], CATALOG.slice(1), [...CATALOG, CATALOG[0]],
    CATALOG.map((entry) => ({ ...entry, gameVersionTypeID: 999 })),
    CATALOG.map((entry) => ({ ...entry, id: 1 })),
    [{ ...CATALOG[0], id: '16984' }, ...CATALOG.slice(1)],
    [{ ...CATALOG[0], apiVersion: '120100' }, ...CATALOG.slice(1)],
    [{ ...CATALOG[0], name: '12.1.5 (Retail)' }, ...CATALOG.slice(1)],
  ];
  for (const catalog of cases) {
    const calls = [];
    await assert.rejects(prepare({ fetchImpl: async (url, init) => {
      calls.push(init.method); return json(catalog);
    } }), isPreparationError);
    assert.deepEqual(calls, ['GET']);
  }
});

test('invalid input and wrong artifact digest fail before any authenticated request', async () => {
  for (const overrides of [
    { tag: 'v1.0.156\n' }, { tag: 'v01.0.156' }, { token: 'secret\nvalue' },
    { changelog: '' }, { changelog: 'x'.repeat(1024 * 1024 + 1) },
    { archiveBytes: Buffer.alloc(0) }, { expectedSha256: 'a'.repeat(64) },
    { expectedSha256: `${digest(BYTES)}\n` }, { timeoutMs: 60_001 },
  ]) {
    let calls = 0;
    await assert.rejects(prepare({ ...overrides, fetchImpl: async () => { calls += 1; } }), isPreparationError);
    assert.equal(calls, 0);
  }
});

test('upload sends exactly the digest-validated bytes and metadata to the fixed project', async () => {
  const mutable = Buffer.from(BYTES);
  const prepared = await prepare({ archiveBytes: mutable, fetchImpl: async () => {
    mutable.fill(0); return json(CATALOG);
  } });
  assert.throws(() => { prepared.metadata.gameVersions.push(1); }, TypeError);
  assert.throws(() => { prepared.metadata.displayName = 'different'; }, TypeError);
  let calls = 0;
  const result = await uploadCurseForge({ prepared, token: TOKEN, fetchImpl: async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://www.curseforge.com/api/projects/1530765/upload-file');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Api-Token'], TOKEN);
    assert.equal(init.headers['Content-Type'], undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(init.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ['metadata', 'file']);
    assert.deepEqual(JSON.parse(init.body.get('metadata')), prepared.metadata);
    const file = init.body.get('file');
    assert.equal(file.name, 'QuickWoWTalents-1.0.156.zip');
    assert.equal(file.type, 'application/zip');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), BYTES);
    assert.equal(digest(Buffer.from(await file.arrayBuffer())), prepared.expectedSha256);
    return json({ id: 700001 });
  } });
  assert.deepEqual(result, { fileId: 700001 });
  assert.equal(calls, 1);
});

test('forged preparations and invalid tokens cannot upload', async () => {
  const prepared = await prepare();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({ id: 1 }); };
  await assert.rejects(uploadCurseForge({ prepared: { ...prepared }, token: TOKEN, fetchImpl }), isPreparationError);
  await assert.rejects(uploadCurseForge({ prepared, token: '', fetchImpl }), isPreparationError);
  assert.equal(calls, 0);
});

test('one prepared artifact cannot upload twice, including concurrent callers', async () => {
  const prepared = await prepare();
  let calls = 0;
  let finish;
  const fetchImpl = async () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); };
  const first = uploadCurseForge({ prepared, token: TOKEN, fetchImpl });
  await assert.rejects(uploadCurseForge({ prepared, token: TOKEN, fetchImpl }), isAmbiguousError);
  finish(json({ id: 700001 }));
  assert.deepEqual(await first, { fileId: 700001 });
  await assert.rejects(uploadCurseForge({ prepared, token: TOKEN, fetchImpl }), isAmbiguousError);
  assert.equal(calls, 1);
});

test('HTTP, network, redirect and malformed receipts produce sanitized ambiguous failures without retry', async () => {
  const cases = [
    async () => { throw new Error(`private ${TOKEN}`); },
    async () => new Response(`secret-response ${TOKEN}`, { status: 500 }),
    async () => new Response('', { status: 302, headers: { location: 'https://private.test/' } }),
    async () => ({ status: 200, redirected: true }),
    async () => new Response(`secret-response ${TOKEN}`),
    async () => json({ id: '700001' }), async () => json({ id: 0 }),
    async () => json({ id: Number.MAX_SAFE_INTEGER + 1 }), async () => json([]),
    async () => new Response('x'.repeat(64 * 1024 + 1)),
    async () => new Response('{}', { headers: { 'content-length': '65537' } }),
    async () => new Response(Uint8Array.from([0xff])),
  ];
  for (const response of cases) {
    const prepared = await prepare();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response(); };
    await assert.rejects(uploadCurseForge({ prepared, token: TOKEN, fetchImpl }), isAmbiguousError);
    await assert.rejects(uploadCurseForge({ prepared, token: TOKEN, fetchImpl }), isAmbiguousError);
    assert.equal(calls, 1);
  }
});

test('upload deadline covers both response headers and a stalled response body', async () => {
  for (const response of [
    () => new Promise(() => {}),
    () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const prepared = await prepare();
    let calls = 0;
    let signal;
    const started = performance.now();
    await assert.rejects(uploadCurseForge({ prepared, token: TOKEN, timeoutMs: 30,
      fetchImpl: async (url, init) => { calls += 1; signal = init.signal; return response(); },
    }), isAmbiguousError);
    assert.ok(performance.now() - started < 1000);
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  }
});

test('metadata errors, limits and a stalled body fail safely without upload', async () => {
  for (const response of [
    () => new Response('secret-response', { status: 401 }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response(new ReadableStream({ start() {} })),
  ]) {
    let calls = 0;
    await assert.rejects(prepare({ timeoutMs: 30, fetchImpl: async (url, init) => {
      calls += 1; assert.equal(init.method, 'GET'); return response();
    } }), isPreparationError);
    assert.equal(calls, 1);
  }
});
