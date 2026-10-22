import { createHash } from 'node:crypto';

const BRANCH = 'curseforge-publications';
const PROJECT_ID = 1530765;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_RECORD_BYTES = 4096;
const NOT_FOUND = Symbol('missing receipt');
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESERVED_FIELDS = [
  'schema', 'status', 'tag', 'sourceCommit', 'archiveSha256',
  'projectId', 'reservationId', 'createdAt',
];
const PUBLISHED_FIELDS = [...RESERVED_FIELDS, 'fileId', 'publishedAt'];

function fail(message) {
  throw new Error(`CurseForge publication ledger failed: ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function assertTag(tag) {
  if (typeof tag !== 'string' || tag.length > 64 || !TAG.test(tag)
      || !tag.slice(1).split('.').every((part) => Number.isSafeInteger(Number(part)))) {
    fail('invalid release tag.');
  }
}

function assertTimestamp(value) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) fail('invalid receipt timestamp.');
  const canonical = new Date(value).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    fail('invalid receipt timestamp.');
  }
}

function validateRecord(value, status) {
  if (!plainObject(value)) fail('invalid receipt shape.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = descriptors.status?.value === 'reserved' ? RESERVED_FIELDS : PUBLISHED_FIELDS;
  if (Reflect.ownKeys(value).length !== fields.length
      || fields.some((field) => !descriptors[field]?.enumerable
        || !Object.hasOwn(descriptors[field], 'value'))) fail('invalid receipt shape.');
  if (!['reserved', 'published'].includes(value.status) || (status && value.status !== status)
      || value.schema !== 1 || value.projectId !== PROJECT_ID
      || typeof value.sourceCommit !== 'string' || !OBJECT_ID.test(value.sourceCommit)
      || typeof value.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.archiveSha256)
      || typeof value.reservationId !== 'string' || !UUID.test(value.reservationId)) {
    fail('invalid receipt identity.');
  }
  assertTag(value.tag);
  assertTimestamp(value.createdAt);
  if (value.status === 'published') {
    if (!Number.isSafeInteger(value.fileId) || value.fileId <= 0) fail('invalid published file ID.');
    assertTimestamp(value.publishedAt);
    if (Date.parse(value.publishedAt) < Date.parse(value.createdAt)) fail('publication precedes reservation.');
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, value[field]])));
}

function bytesFor(record) {
  return Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
}

function blobHash(bytes, sha) {
  return createHash(sha.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function validateContent(content, tag) {
  if (!plainObject(content) || content.type !== 'file'
      || content.name !== `${tag}.json` || content.path !== `receipts/${tag}.json`
      || typeof content.sha !== 'string' || !OBJECT_ID.test(content.sha)
      || !Number.isSafeInteger(content.size) || content.size < 1 || content.size > MAX_RECORD_BYTES
      || Object.hasOwn(content, 'target') || Object.hasOwn(content, 'submodule_git_url')) {
    fail('invalid GitHub content identity.');
  }
}

function verifyBlob(content, bytes) {
  if (content.size !== bytes.length || content.sha !== blobHash(bytes, content.sha)) {
    fail('GitHub receipt content does not match its blob identity.');
  }
}

function decodeReceipt(content, tag) {
  validateContent(content, tag);
  if (content.encoding !== 'base64' || typeof content.content !== 'string'
      || content.content.length > MAX_RECORD_BYTES * 2
      || !/^[A-Za-z0-9+/=\r\n]+$/.test(content.content)) fail('invalid encoded receipt.');
  const encoded = content.content.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail('invalid encoded receipt.');
  verifyBlob(content, bytes);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('receipt is not valid UTF-8 JSON.');
  }
  const record = validateRecord(value);
  if (record.tag !== tag) fail('receipt belongs to a different release.');
  return record;
}

/**
 * The branch is initialized separately. A claim is a Contents API create with
 * no sha; GitHub rejects an existing path instead of overwriting its receipt.
 * https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
 */
export function createPublicationLedger({
  token, fetchImpl = fetch, repository = 'QuickWoWTalents/quickwowtalents-addon',
} = {}) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096
      || !/^[\x21-\x7e]+$/.test(token) || typeof fetchImpl !== 'function'
      || typeof repository !== 'string' || repository.length > 200
      || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) {
    fail('invalid ledger configuration.');
  }
  const verifiedReceipts = new WeakSet();
  function receipt(record, sha) {
    const result = Object.freeze({ record, sha });
    verifiedReceipts.add(result);
    return result;
  }

  async function request(tag, method, body, expectedStatus) {
    assertTag(tag);
    const url = `https://api.github.com/repos/${repository}/contents/receipts/${tag}.json`
      + (method === 'GET' ? `?ref=${BRANCH}` : '');
    const controller = new AbortController();
    let timer;
    let reader;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Ledger deadline exceeded.'));
      }, REQUEST_TIMEOUT_MS);
    });
    const operation = async () => {
      const response = await fetchImpl(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.redirected || (response.url && response.url !== url)) fail('unexpected GitHub redirect.');
      if (method === 'GET' && response.status === 404) return NOT_FOUND;
      if (response.status !== expectedStatus) fail('GitHub rejected the ledger operation.');
      const contentType = response.headers.get('content-type');
      const length = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(contentType ?? '')
          || (encoding !== null && !['identity', 'gzip', 'deflate', 'br'].includes(encoding))
          || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))) {
        fail('invalid GitHub response metadata.');
      }
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) fail('invalid GitHub response body.');
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) fail('GitHub response exceeds the size limit.');
        chunks.push(Buffer.from(value));
      }
      // Fetch decompresses bodies but retains the compressed Content-Length.
      // Always bound decoded bytes; equality applies only to identity encoding.
      if (size === 0 || (length !== null && (encoding === null || encoding === 'identity')
          && Number(length) !== size)) fail('incomplete GitHub response body.');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch {
      // A timeout may follow a successful remote write. Never retry, expose the
      // server body/token, or reinterpret an unknown outcome as upload authority.
      fail('GitHub operation was unsuccessful or its outcome is unknown.');
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  async function write(record, priorSha) {
    const bytes = bytesFor(record);
    const result = await request(record.tag, 'PUT', {
      message: `${record.status === 'reserved' ? 'Reserve' : 'Record'} CurseForge publication ${record.tag}`,
      branch: BRANCH, content: bytes.toString('base64'),
      ...(priorSha ? { sha: priorSha } : {}),
    }, priorSha ? 200 : 201);
    if (!plainObject(result) || Object.keys(result).some((key) => !['content', 'commit'].includes(key))
        || !plainObject(result.commit) || !OBJECT_ID.test(result.commit.sha ?? '')) {
      fail('invalid GitHub write receipt.');
    }
    validateContent(result.content, record.tag);
    verifyBlob(result.content, bytes);
    return receipt(record, result.content.sha);
  }

  return Object.freeze({
    async read(tag) {
      const content = await request(tag, 'GET', null, 200);
      if (content === NOT_FOUND) return null;
      return receipt(decodeReceipt(content, tag), content.sha);
    },
    async claim(record) {
      return write(validateRecord(record, 'reserved'));
    },
    async complete(claim, publishedRecord) {
      if (!verifiedReceipts.has(claim) || claim.record.status !== 'reserved') {
        fail('completion requires a verified reserved receipt from this ledger.');
      }
      const record = validateRecord(publishedRecord, 'published');
      if (RESERVED_FIELDS.some((field) => field !== 'status' && record[field] !== claim.record[field])) {
        fail('publication identity differs from its reservation.');
      }
      return write(record, claim.sha);
    },
  });
}
