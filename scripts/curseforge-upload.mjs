import { createHash } from 'node:crypto';

const GAME_VERSIONS_URL = 'https://wow.curseforge.com/api/game/versions';
const UPLOAD_URL = 'https://www.curseforge.com/api/projects/1530765/upload-file';
const RETAIL_VERSION_TYPE = 517;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_CHANGELOG_BYTES = 1024 * 1024;
const preparedUploads = new WeakMap();
const attemptedUploads = new WeakSet();

function preparationError(message = 'CurseForge upload preparation failed.') {
  const error = new Error(message);
  error.code = 'CURSEFORGE_PREPARATION_FAILED';
  return error;
}

function ambiguousError() {
  const error = new Error('CurseForge upload outcome is unknown; do not retry automatically.');
  error.code = 'CURSEFORGE_UPLOAD_AMBIGUOUS';
  error.ambiguous = true;
  return error;
}

function validateToken(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
    throw preparationError('A valid CurseForge API token is required.');
  }
}

function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw preparationError('CurseForge request timeout is invalid.');
  }
}

export function parseSupportedGameVersions(tocText) {
  if (typeof tocText !== 'string' || Buffer.byteLength(tocText) > 64 * 1024
      || tocText.includes('\0')) throw preparationError('Addon TOC is invalid.');
  const lines = tocText.split(/\r?\n/).filter((line) => /^\s*##\s*Interface\b/i.test(line));
  if (lines.length !== 1 || !/^## Interface: [1-9]\d{4,5}(?:, ?[1-9]\d{4,5})*$/.test(lines[0])) {
    throw preparationError('Addon TOC must contain exactly one valid Interface declaration.');
  }
  const interfaces = lines[0].slice('## Interface: '.length).split(',').map((value) => value.trim());
  if (interfaces.length > 32 || new Set(interfaces).size !== interfaces.length) {
    throw preparationError('Addon TOC Interface values must be unique and bounded.');
  }
  return interfaces.map((value) => {
    const numeric = Number(value);
    return `${Math.floor(numeric / 10_000)}.${Math.floor(numeric / 100) % 100}.${numeric % 100}`;
  });
}

async function boundedJsonRequest({ fetchImpl, url, init, maximumBytes, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  let reader;
  const operation = (async () => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    if (response?.redirected || !Number.isInteger(response?.status)
        || response.status < 200 || response.status >= 300) throw new Error('Request failed.');
    const length = response.headers?.get('content-length');
    if (length !== null && length !== undefined
        && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) throw new Error('Body is oversized.');
    if (typeof response.body?.getReader !== 'function') throw new Error('Body is unavailable.');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid body chunk.');
      size += value.byteLength;
      if (size > maximumBytes) throw new Error('Body is oversized.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancel without waiting: an uncooperative response body must not defeat the deadline.
    if (reader) reader.cancel().catch(() => {});
  }
}

export async function prepareCurseForgeUpload({
  tag, tocText, changelog, archiveBytes, expectedSha256, token,
  fetchImpl = globalThis.fetch, timeoutMs = 30_000,
}) {
  validateToken(token);
  validateTimeout(timeoutMs);
  if (typeof fetchImpl !== 'function') throw preparationError('CurseForge fetch implementation is invalid.');
  if (typeof tag !== 'string' || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)
      || tag.length > 128 || /\s/.test(tag)) throw preparationError('CurseForge release tag is invalid.');
  if (typeof changelog !== 'string' || !changelog.trim() || changelog.includes('\0')
      || Buffer.byteLength(changelog) > MAX_CHANGELOG_BYTES) throw preparationError('CurseForge changelog is invalid.');
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength === 0
      || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) throw preparationError('CurseForge archive is invalid.');
  // Copy before the first await; later changes to the caller's buffer cannot change the upload.
  const archive = new Blob([archiveBytes], { type: 'application/zip' });
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)
      || expectedSha256.length !== 64
      || createHash('sha256').update(archiveBytes).digest('hex') !== expectedSha256) {
    throw preparationError('CurseForge archive SHA-256 does not match the verified artifact.');
  }
  const versions = parseSupportedGameVersions(tocText);
  let catalog;
  try {
    catalog = await boundedJsonRequest({
      fetchImpl, url: GAME_VERSIONS_URL,
      init: { method: 'GET', headers: { 'X-Api-Token': token, Accept: 'application/json' } },
      maximumBytes: 2 * 1024 * 1024, timeoutMs,
    });
  } catch {
    throw preparationError('CurseForge game-version lookup failed; no upload was attempted.');
  }
  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 10_000) {
    throw preparationError('CurseForge game-version catalog is invalid.');
  }
  const gameVersions = versions.map((name) => {
    const matches = catalog.filter((entry) => entry?.name === name
      && entry.gameVersionTypeID === RETAIL_VERSION_TYPE);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) {
      throw preparationError('A supported retail game version is missing or ambiguous.');
    }
    const [major, minor, patch] = name.split('.').map(Number);
    const apiVersion = String(major * 10_000 + minor * 100 + patch);
    if (matches[0].apiVersion !== undefined && matches[0].apiVersion !== apiVersion) {
      throw preparationError('CurseForge game-version Interface metadata does not match.');
    }
    return matches[0].id;
  });
  if (new Set(gameVersions).size !== gameVersions.length) {
    throw preparationError('CurseForge game-version IDs must be unique.');
  }
  const metadata = Object.freeze({
    displayName: tag, releaseType: 'release', changelogType: 'markdown', changelog,
    gameVersions: Object.freeze(gameVersions),
  });
  const prepared = Object.freeze({
    tag, archiveName: `QuickWoWTalents-${tag.slice(1)}.zip`, expectedSha256,
    metadata, archiveBytes: archive,
  });
  preparedUploads.set(prepared, prepared);
  return prepared;
}

export async function uploadCurseForge({
  prepared, token, fetchImpl = globalThis.fetch, timeoutMs = 60_000,
}) {
  validateToken(token);
  validateTimeout(timeoutMs);
  if (typeof fetchImpl !== 'function' || !preparedUploads.has(prepared)) {
    throw preparationError('A verified prepared CurseForge upload is required.');
  }
  if (attemptedUploads.has(prepared)) throw ambiguousError();
  const payload = preparedUploads.get(prepared);
  const body = new FormData();
  body.set('metadata', JSON.stringify(payload.metadata));
  body.set('file', payload.archiveBytes, payload.archiveName);
  // This is an additional in-process guard. The caller owns the durable cross-run reservation.
  attemptedUploads.add(prepared);
  try {
    const result = await boundedJsonRequest({
      fetchImpl, url: UPLOAD_URL,
      init: { method: 'POST', headers: { 'X-Api-Token': token, Accept: 'application/json' }, body },
      maximumBytes: 64 * 1024, timeoutMs,
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || !Number.isSafeInteger(result.id) || result.id <= 0) throw new Error('Invalid upload receipt.');
    return { fileId: result.id };
  } catch {
    throw ambiguousError();
  }
}
