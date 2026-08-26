import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export const RELEASE_INPUT_SNAPSHOT_VERSION = 1;
export const MAX_RELEASE_INPUT_MANIFEST_BYTES = 64 * 1024;
export const MAX_RELEASE_INPUT_OPTIONS_BYTES = 4 * 1024 * 1024;
export const MAX_RELEASE_INPUT_CATALOG_GZIP_BYTES = 16 * 1024 * 1024;
export const MAX_RELEASE_INPUT_CATALOG_JSON_BYTES = 128 * 1024 * 1024;
export const MAX_RELEASE_INPUT_ADDON_BYTES = 16 * 1024 * 1024;

const FILE_NAMES = ['options', 'catalog', 'addon'];

class ReleaseInputSnapshotError extends Error {
  constructor(message) {
    super(`Release input snapshot validation failed: ${message}`);
    this.name = 'ReleaseInputSnapshotError';
  }
}

function fail(message) {
  throw new ReleaseInputSnapshotError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be a keyed object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly ${expected.join(', ')}.`);
  }
}

function toBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`${label} bytes must be a Buffer or Uint8Array.`);
  }
  return Buffer.from(value);
}

function digestRecord(value, label) {
  const bytes = toBytes(value, label);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

export function createReleaseInputSnapshotManifest({
  optionsBytes,
  catalogBytes,
  addonBytes,
}) {
  return {
    version: RELEASE_INPUT_SNAPSHOT_VERSION,
    files: {
      options: digestRecord(optionsBytes, 'options'),
      catalog: digestRecord(catalogBytes, 'catalog'),
      addon: digestRecord(addonBytes, 'addon'),
    },
  };
}

export function serializeReleaseInputSnapshotManifest(inputs) {
  return Buffer.from(`${JSON.stringify(createReleaseInputSnapshotManifest(inputs))}\n`, 'utf8');
}

function parseReleaseInputSnapshotManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(toBytes(bytes, 'manifest').toString('utf8'));
  } catch (error) {
    if (error instanceof ReleaseInputSnapshotError) throw error;
    fail('manifest must be valid JSON.');
  }
  exactKeys(manifest, ['version', 'files'], 'manifest');
  if (manifest.version !== RELEASE_INPUT_SNAPSHOT_VERSION) {
    fail(`manifest version must be exactly ${RELEASE_INPUT_SNAPSHOT_VERSION}.`);
  }
  exactKeys(manifest.files, FILE_NAMES, 'manifest files');
  for (const name of FILE_NAMES) {
    const record = manifest.files[name];
    exactKeys(record, ['sha256', 'bytes'], `manifest ${name} record`);
    if (!/^[0-9a-f]{64}$/.test(record.sha256)) {
      fail(`manifest ${name} SHA-256 must be 64 lowercase hexadecimal characters.`);
    }
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      fail(`manifest ${name} byte length must be a non-negative safe integer.`);
    }
  }
  return manifest;
}

async function readRegularFileBounded(filePath, {
  label,
  maximumBytes,
  expectedBytes = null,
}) {
  if (typeof filePath !== 'string' || !filePath) {
    fail(`${label} path must be a non-empty string.`);
  }
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail(`${label} snapshot must be a regular file.`);
    }
    if (stat.size > maximumBytes) {
      fail(`${label} byte length exceeds the fixed size limit.`);
    }
    if (expectedBytes !== null && stat.size !== expectedBytes) {
      fail(`${label} byte length does not match the committed manifest.`);
    }
    const chunks = [];
    let length = 0;
    let position = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maximumBytes) {
        fail(`${label} byte length exceeds the fixed size limit.`);
      }
      if (expectedBytes !== null && length > expectedBytes) {
        fail(`${label} byte length does not match the committed manifest.`);
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (expectedBytes !== null && length !== expectedBytes) {
      fail(`${label} byte length does not match the committed manifest.`);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof ReleaseInputSnapshotError) throw error;
    fail(`${label} snapshot could not be read.`);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        fail(`${label} snapshot could not be closed safely.`);
      }
    }
  }
}

async function readManifestBounded(manifestPath) {
  return readRegularFileBounded(manifestPath, {
    label: 'manifest',
    maximumBytes: MAX_RELEASE_INPUT_MANIFEST_BYTES,
  });
}

function verifySnapshotBytes(manifest, inputBytes) {
  const actual = createReleaseInputSnapshotManifest(inputBytes);
  for (const name of FILE_NAMES) {
    if (manifest.files[name].bytes !== actual.files[name].bytes) {
      fail(`${name} byte length does not match the committed manifest.`);
    }
    if (manifest.files[name].sha256 !== actual.files[name].sha256) {
      fail(`${name} SHA-256 does not match the committed manifest.`);
    }
  }
}

export async function verifyReleaseInputSnapshot({
  manifestPath,
  optionsBytes,
  catalogBytes,
  addonBytes,
}) {
  const manifest = parseReleaseInputSnapshotManifest(await readManifestBounded(manifestPath));
  verifySnapshotBytes(manifest, { optionsBytes, catalogBytes, addonBytes });
  return manifest;
}

export async function loadVerifiedReleaseInputSnapshot({
  manifestPath,
  optionsPath,
  catalogPath,
  addonPath,
}) {
  const manifest = parseReleaseInputSnapshotManifest(await readManifestBounded(manifestPath));
  const fileLimits = {
    options: MAX_RELEASE_INPUT_OPTIONS_BYTES,
    catalog: catalogPath.endsWith('.json')
      ? MAX_RELEASE_INPUT_CATALOG_JSON_BYTES
      : MAX_RELEASE_INPUT_CATALOG_GZIP_BYTES,
    addon: MAX_RELEASE_INPUT_ADDON_BYTES,
  };
  for (const name of FILE_NAMES) {
    if (manifest.files[name].bytes > fileLimits[name]) {
      fail(`${name} byte length exceeds the fixed size limit.`);
    }
  }

  const [optionsBytes, catalogBytes, addonBytes] = await Promise.all([
    readRegularFileBounded(optionsPath, {
      label: 'options',
      maximumBytes: fileLimits.options,
      expectedBytes: manifest.files.options.bytes,
    }),
    readRegularFileBounded(catalogPath, {
      label: 'catalog',
      maximumBytes: fileLimits.catalog,
      expectedBytes: manifest.files.catalog.bytes,
    }),
    readRegularFileBounded(addonPath, {
      label: 'addon',
      maximumBytes: fileLimits.addon,
      expectedBytes: manifest.files.addon.bytes,
    }),
  ]);
  verifySnapshotBytes(manifest, { optionsBytes, catalogBytes, addonBytes });
  return { manifest, optionsBytes, catalogBytes, addonBytes };
}
