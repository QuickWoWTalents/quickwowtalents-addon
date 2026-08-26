import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

export const DEFAULT_MAX_CATALOG_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_CATALOG_EXPANDED_BYTES = 128 * 1024 * 1024;

const DOWNLOAD_FIELDS = ['path', 'sha256', 'bytes', 'mediaType'];

class CatalogDownloadError extends Error {
  constructor(message) {
    super(`Catalog download validation failed: ${message}`);
    this.name = 'CatalogDownloadError';
  }
}

function fail(message) {
  throw new CatalogDownloadError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer.`);
  return value;
}

export function parseCatalogDownloadDescriptor(
  options,
  {
    optionsUrl = null,
    maxCompressedBytes = DEFAULT_MAX_CATALOG_COMPRESSED_BYTES,
  } = {},
) {
  if (!isRecord(options)) fail('options must be a keyed object.');
  const descriptor = options.talentCatalogDownload;
  if (!isRecord(descriptor)) fail('options talentCatalogDownload must be a keyed object.');

  const actualFields = Object.keys(descriptor).sort();
  const expectedFields = [...DOWNLOAD_FIELDS].sort();
  if (actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])) {
    fail(`options talentCatalogDownload must contain exactly four descriptor fields: ${DOWNLOAD_FIELDS.join(', ')}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
    fail('options talentCatalogDownload.sha256 must be 64 lowercase hexadecimal characters.');
  }
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0) {
    fail('options talentCatalogDownload.bytes must be a positive safe integer.');
  }
  if (descriptor.bytes > positiveLimit(maxCompressedBytes, 'compressed catalog size limit')) {
    fail('compressed catalog size exceeds the configured limit.');
  }
  if (descriptor.mediaType !== 'application/gzip') {
    fail('options talentCatalogDownload.mediaType must be application/gzip.');
  }

  const expectedPath = `/api/talent-catalog?sha256=${descriptor.sha256}`;
  if (descriptor.path !== expectedPath) {
    fail('options talentCatalogDownload.path must be the exact same-origin content-addressed catalog path.');
  }

  let url = null;
  if (optionsUrl !== null) {
    let baseUrl;
    try {
      baseUrl = new URL(optionsUrl);
    } catch {
      fail('configured options endpoint must be a valid HTTPS URL.');
    }
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
      fail('configured options endpoint must be an HTTPS URL without embedded credentials.');
    }
    const resolvedUrl = new URL(descriptor.path, baseUrl);
    if (resolvedUrl.protocol !== 'https:' || resolvedUrl.origin !== baseUrl.origin
      || resolvedUrl.username || resolvedUrl.password) {
      fail('catalog download URL must resolve to the same HTTPS origin as options.');
    }
    url = resolvedUrl.href;
  }

  return { ...descriptor, url };
}

export async function expandCatalogGzipWithLimit(
  bytes,
  maxExpandedBytes = DEFAULT_MAX_CATALOG_EXPANDED_BYTES,
) {
  const maximum = positiveLimit(maxExpandedBytes, 'expanded catalog size limit');
  const source = Readable.from([bytes]);
  const gunzip = createGunzip();
  const stream = source.pipe(gunzip);
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > maximum) {
        stream.destroy();
        fail('expanded catalog size exceeds the configured limit.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof CatalogDownloadError) throw error;
    fail('downloaded catalog is not a valid gzip archive.');
  } finally {
    source.destroy();
    stream.destroy();
  }
  return Buffer.concat(chunks, length);
}

export async function parseVerifiedCatalogArchive(
  archiveBytes,
  descriptor,
  { maxExpandedBytes = DEFAULT_MAX_CATALOG_EXPANDED_BYTES } = {},
) {
  const bytes = Buffer.isBuffer(archiveBytes) ? archiveBytes : Buffer.from(archiveBytes);
  if (bytes.length !== descriptor.bytes) {
    fail('downloaded catalog byte length does not match options.');
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== descriptor.sha256) {
    fail('downloaded catalog SHA-256 does not match options.');
  }
  const expandedBytes = await expandCatalogGzipWithLimit(bytes, maxExpandedBytes);
  let catalog;
  try {
    catalog = JSON.parse(expandedBytes.toString('utf8'));
  } catch {
    fail('normalized catalog JSON could not be parsed.');
  }
  if (!isRecord(catalog)) fail('normalized catalog JSON must be a keyed object.');
  return catalog;
}

export async function loadVerifiedCatalogSnapshot(
  catalogPath,
  options,
  {
    maxCompressedBytes = DEFAULT_MAX_CATALOG_COMPRESSED_BYTES,
    maxExpandedBytes = DEFAULT_MAX_CATALOG_EXPANDED_BYTES,
  } = {},
) {
  const descriptor = parseCatalogDownloadDescriptor(options, { maxCompressedBytes });
  const maximum = positiveLimit(maxCompressedBytes, 'compressed catalog size limit');
  let handle;
  let bytes;
  try {
    handle = await fs.open(catalogPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) fail('persisted catalog snapshot must be a regular file.');
    if (stat.size > maximum) fail('compressed catalog size exceeds the configured limit.');

    const chunks = [];
    let length = 0;
    let position = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1));
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maximum) fail('compressed catalog size exceeds the configured limit.');
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
    }
    bytes = Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof CatalogDownloadError) throw error;
    fail('persisted catalog snapshot could not be read.');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        fail('persisted catalog snapshot could not be closed safely.');
      }
    }
  }
  return parseVerifiedCatalogArchive(bytes, descriptor, { maxExpandedBytes });
}
