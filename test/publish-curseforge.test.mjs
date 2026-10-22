import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isLegacyPackagerTag, parseCurseForgeArgs, publishCurseForge } from '../scripts/publish-curseforge.mjs';

const tag = 'v1.0.156';
const archiveBytes = Buffer.from('validated archive fixture');
const artifact = {
  tag, sourceCommit: 'a'.repeat(40), archiveBytes,
  archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
  tocText: '## Interface: 120105', changelog: 'Release notes',
};
function fixture(overrides = {}) {
  let saved = null;
  const calls = [];
  const ledger = {
    async read() { calls.push('read'); return saved; },
    async claim(record) {
      calls.push('claim');
      if (saved) throw new Error('already claimed');
      saved = { record: { ...record }, sha: 'b'.repeat(40) };
      return saved;
    },
    async complete(claim, record) {
      calls.push('complete'); assert.equal(claim, saved);
      saved = { record: { ...record }, sha: 'c'.repeat(40) };
    },
  };
  const options = {
    tag, enabled: 'true', token: 'test-token', ledger,
    loadArtifact: async ({ tag: requested }) => { calls.push('verify'); return { ...artifact, tag: requested }; },
    prepareUpload: async (input) => {
      calls.push('prepare'); assert.equal(input.archiveBytes, archiveBytes);
      assert.equal(input.expectedSha256, artifact.archiveSha256); return { prepared: true };
    },
    upload: async ({ prepared }) => { calls.push('post'); assert.equal(prepared.prepared, true); return { fileId: 123 }; },
    now: () => '2026-10-22T17:00:00.000Z', uuid: () => 'a6ad9b3c-8e57-400a-9ecb-ac8c1f026750',
    ...overrides,
  };
  return { options, calls, ledger, run: (extra = {}) => publishCurseForge({ ...options, ...extra }),
    setSaved: (value) => { saved = value; }, getSaved: () => saved };
}

test('verified artifact is prepared, durably reserved and uploaded once; rerun only verifies receipt', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { ok: true, action: 'uploaded', tag, fileId: 123 });
  assert.deepEqual(f.calls, ['verify', 'read', 'prepare', 'claim', 'post', 'complete']);
  assert.deepEqual(await f.run(), { ok: true, action: 'already-published', tag, fileId: 123 });
  assert.equal(f.calls.filter((value) => value === 'post').length, 1);
});

test('simultaneous attempts cannot both upload the same version', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter((value) => value === 'post').length, 1);
});

test('timeout after accepting an upload leaves a reservation and reruns cannot POST again', async () => {
  const f = fixture({ upload: async () => { throw new Error('ambiguous timeout'); } });
  await assert.rejects(f.run(), /ambiguous timeout/);
  assert.equal(f.getSaved().record.status, 'reserved');
  await assert.rejects(f.run(), /already reserved/);
  assert.equal(f.calls.filter((value) => value === 'claim').length, 1);
});

test('successful upload with failed receipt persistence remains reserved and exposes only file ID for recovery', async () => {
  const f = fixture();
  f.ledger.complete = async () => { throw new Error('network response with secret'); };
  await assert.rejects(f.run(), /file 123 was accepted but receipt persistence failed/);
  await assert.rejects(f.run(), /already reserved/);
  assert.equal(f.calls.filter((value) => value === 'post').length, 1);
});

test('failed or ambiguous reservation prevents any upload', async () => {
  const f = fixture();
  f.ledger.claim = async () => { throw new Error('reservation uncertain'); };
  await assert.rejects(f.run(), /reservation uncertain/);
  assert.equal(f.calls.includes('post'), false);
});

test('malformed metadata, failed validation and digest mismatch cannot reserve a version', async () => {
  for (const overrides of [
    { loadArtifact: async () => { throw new Error('validation failed'); } },
    { loadArtifact: async () => ({ ...artifact, archiveSha256: 'f'.repeat(64) }) },
    { loadArtifact: async () => ({ ...artifact, sourceCommit: 'invalid' }) },
    { prepareUpload: async () => { throw new Error('unsupported game version'); } },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(f.run());
    assert.equal(f.calls.includes('claim'), false);
    assert.equal(f.calls.includes('post'), false);
  }
});

test('same version with different source or archive is rejected even with completed receipt', async () => {
  for (const field of ['sourceCommit', 'archiveSha256']) {
    const f = fixture(); await f.run();
    f.getSaved().record[field] = 'f'.repeat(field === 'sourceCommit' ? 40 : 64);
    await assert.rejects(f.run(), /different source or archive bytes/);
    assert.equal(f.calls.filter((value) => value === 'post').length, 1);
  }
});

test('read-only check performs artifact and metadata validation without claiming or uploading', async () => {
  const f = fixture({ enabled: undefined });
  assert.equal((await f.run({ checkOnly: true })).action, 'checked');
  assert.deepEqual(f.calls, ['verify', 'read', 'prepare']);
});

test('every pre-cutover version including duplicate v1.0.155 is permanently protected from reupload', async () => {
  for (const version of ['v0.9.999', 'v1.0.0', 'v1.0.154', 'v1.0.155']) {
    const f = fixture({ tag: version });
    assert.equal((await f.run()).action, 'legacy-version-no-upload');
    assert.deepEqual(f.calls, ['verify', 'read', 'prepare']);
  }
  for (const version of ['v1.0.156', 'v1.1.0', 'v2.0.0']) assert.equal(isLegacyPackagerTag(version), false);
});

test('disabled cutover, missing credential, invalid tag and CLI options fail before work', async () => {
  for (const extra of [{ enabled: 'false' }, { token: '' }, { tag: '../main' }, { checkOnly: 'false' }]) {
    const f = fixture(); await assert.rejects(f.run(extra)); assert.deepEqual(f.calls, []);
  }
  assert.deepEqual(parseCurseForgeArgs(['--check', '--tag', tag]), { checkOnly: true, tag });
  for (const args of [[], ['--tag', 'v01.2.3'], ['--tag', tag, '--force'], ['--retry', '--tag', tag]]) {
    assert.throws(() => parseCurseForgeArgs(args));
  }
});
