#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_MAX_CATALOG_COMPRESSED_BYTES,
  DEFAULT_MAX_CATALOG_EXPANDED_BYTES,
  parseCatalogDownloadDescriptor,
  parseVerifiedCatalogArchive,
} from './catalog-download-contract.mjs';
import {
  loadCatalogForOptions,
  validateAddonContract,
  validateOptionsCatalog,
} from './validate-addon-contract.mjs';
import { serializeReleaseInputSnapshotManifest } from './release-input-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ADDON_URL = 'https://quickwowtalents.com/api/addon-data';
const DEFAULT_OPTIONS_URL = 'https://quickwowtalents.com/api/options';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'QuickWoWTalentsData.lua');
const DEFAULT_RETRY_DELAY_MS = 60_000;

function readArg(flag, fallback = null) {
  const indexes = process.argv
    .map((argument, index) => argument === flag ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length > 1) throw new Error(`CLI accepts at most one ${flag} argument.`);
  if (indexes.length === 0) return fallback;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`CLI requires a value for ${flag}.`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetriableDownloadError(error) {
  if (typeof error?.retriable === 'boolean') return error.retriable;
  const status = Number(error?.status ?? 0);
  return isRetriableHttpStatus(status)
    || /ADDON_DATA_INCOMPLETE|temporarily|timeout|fetch failed/i.test(error?.message ?? '');
}

function downloadError(label, message, { status = 0, retriable = false } = {}) {
  const error = new Error(`${label} download ${message}`);
  error.status = status;
  error.retriable = retriable;
  return error;
}

async function fetchResponse({ label, url, timeoutMs, accept }) {
  if (typeof url !== 'string' || !url) throw new Error('Download endpoint URL must be a non-empty string.');
  let response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      headers: {
        accept,
        'user-agent': 'quickwowtalents-addon-release/0.4'
      }
    });
  } catch {
    throw downloadError(label, 'request failed.', { retriable: true });
  }
  if (response.status >= 300 && response.status < 400) {
    throw downloadError(label, 'redirect response is forbidden.', { status: response.status });
  }
  if (typeof response.url === 'string' && response.url) {
    let requestedUrl;
    try {
      requestedUrl = new URL(url).href;
    } catch {
      throw downloadError(label, 'request URL is invalid.');
    }
    if (response.url !== requestedUrl) {
      throw downloadError(label, 'final URL differs from the requested URL; redirects are forbidden.');
    }
  }
  if (!response.ok) {
    throw downloadError(label, `failed with HTTP ${response.status}.`, {
      status: response.status,
      retriable: isRetriableHttpStatus(response.status),
    });
  }
  return response;
}

async function fetchText({ label, url, timeoutMs, accept }) {
  const response = await fetchResponse({ label, url, timeoutMs, accept });
  let text;
  try {
    text = await response.text();
  } catch {
    throw downloadError(label, 'response body could not be read.', {
      status: response.status,
      retriable: true,
    });
  }
  return text;
}

async function fetchTextWithRetries({ label, url, timeoutMs, accept, retries, retryDelayMs }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchText({ label, url, timeoutMs, accept });
    } catch (error) {
      if (attempt >= retries || !isRetriableDownloadError(error)) throw error;
      console.warn(`${label} download attempt ${attempt + 1} failed; retrying in ${retryDelayMs}ms: ${error.message}`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw new Error(`${label} download did not complete.`);
}

function responseHeader(response, name) {
  if (!response.headers || typeof response.headers.get !== 'function') return null;
  const value = response.headers.get(name);
  return value === null ? null : String(value);
}

async function readBoundedResponseBytes(response, { label, maximumBytes }) {
  const contentLength = responseHeader(response, 'content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw downloadError(label, 'returned an invalid content length.');
    }
    if (Number(contentLength) > maximumBytes) {
      throw downloadError(label, 'exceeds the compressed size limit.');
    }
  }

  const chunks = [];
  let length = 0;
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        length += chunk.length;
        if (length > maximumBytes) {
          throw downloadError(label, 'exceeds the compressed size limit.');
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) {
      throw downloadError(label, 'exceeds the compressed size limit.');
    }
    return bytes;
  } catch (error) {
    if (typeof error?.retriable === 'boolean') throw error;
    throw downloadError(label, 'response body could not be read.', {
      status: response.status,
      retriable: true,
    });
  }
}

async function fetchCatalogBytes({
  url,
  descriptor,
  timeoutMs,
  retries,
  retryDelayMs,
  maximumBytes,
}) {
  const label = 'Catalog';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchResponse({
        label,
        url,
        timeoutMs,
        accept: descriptor.mediaType,
      });
      const mediaType = responseHeader(response, 'content-type');
      if (mediaType !== null && mediaType.toLowerCase() !== descriptor.mediaType) {
        throw downloadError(label, 'response media type does not match options.');
      }
      const contentEncoding = responseHeader(response, 'content-encoding');
      if (contentEncoding !== null && contentEncoding.trim() !== '') {
        throw downloadError(label, 'response must not use content encoding.');
      }
      const contentLength = responseHeader(response, 'content-length');
      if (contentLength !== null && /^\d+$/.test(contentLength)
        && Number(contentLength) !== descriptor.bytes) {
        throw downloadError(label, 'response byte length does not match options.');
      }
      return await readBoundedResponseBytes(response, { label, maximumBytes });
    } catch (error) {
      if (attempt >= retries || !isRetriableDownloadError(error)) throw error;
      console.warn(`${label} download attempt ${attempt + 1} failed; retrying in ${retryDelayMs}ms: ${error.message}`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw downloadError(label, 'did not complete.');
}

function parseOptionsJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Downloaded options JSON could not be parsed.');
  }
}

async function stageFileReplacement(outputPath, contents, createTemporaryId, renameFile) {
  const outputDirectory = path.dirname(outputPath);
  await fs.mkdir(outputDirectory, { recursive: true });
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(outputPath)}.${process.pid}.${createTemporaryId()}.tmp`
  );
  let temporaryHandle = null;
  let ownsTemporaryPath = false;
  try {
    temporaryHandle = await fs.open(temporaryPath, 'wx');
    ownsTemporaryPath = true;
    await temporaryHandle.writeFile(contents, Buffer.isBuffer(contents) ? undefined : { encoding: 'utf8' });
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    return {
      outputPath,
      temporaryPath,
      async commit() {
        await renameFile(temporaryPath, outputPath);
        ownsTemporaryPath = false;
      },
      async cleanup() {
        if (!ownsTemporaryPath) return;
        try {
          await fs.unlink(temporaryPath);
          ownsTemporaryPath = false;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          ownsTemporaryPath = false;
        }
      },
    };
  } catch (error) {
    if (temporaryHandle) {
      try {
        await temporaryHandle.close();
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
    }
    if (ownsTemporaryPath) {
      try {
        await fs.unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError ??= cleanupError;
      }
    }
    throw error;
  }
}

async function replaceValidatedFilesAtomically(
  entries,
  { createTemporaryId = randomUUID, renameFile = fs.rename } = {},
) {
  const paths = entries.map(({ outputPath }) => path.resolve(outputPath));
  if (new Set(paths).size !== paths.length) {
    throw new Error('Validated snapshot output paths must be distinct.');
  }
  const staged = [];
  try {
    for (const { outputPath, contents } of entries) {
      staged.push(await stageFileReplacement(outputPath, contents, createTemporaryId, renameFile));
    }
    for (const replacement of staged) await replacement.commit();
  } catch (error) {
    for (const replacement of staged) {
      try {
        await replacement.cleanup();
      } catch (cleanupError) {
        error.cleanupError ??= cleanupError;
      }
    }
    throw error;
  }
}

export async function replaceFileAtomically(
  outputPath,
  contents,
  { createTemporaryId = randomUUID, renameFile = fs.rename } = {}
) {
  await replaceValidatedFilesAtomically(
    [{ outputPath, contents }],
    { createTemporaryId, renameFile },
  );
}

export function normalizeAddonDataForComparison(text) {
  return String(text)
    .replace(/^\s*generatedAt = "[^"]+",\s*$/m, '')
    .replace(/^\s*sourceGeneratedAt = "[^"]+",\s*$/m, '')
    .replace(/^\s*downloadedAt = "[^"]+",\s*$/m, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function addonDataHash(text) {
  return createHash('sha256').update(normalizeAddonDataForComparison(text)).digest('hex');
}

export async function downloadAddonData({
  url = DEFAULT_ADDON_URL,
  optionsUrl = DEFAULT_OPTIONS_URL,
  optionsOutputPath = null,
  catalogPath = null,
  catalogOutputPath = null,
  snapshotManifestOutputPath = null,
  outputPath,
  timeoutMs,
  retries = 0,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxCatalogCompressedBytes = DEFAULT_MAX_CATALOG_COMPRESSED_BYTES,
  maxCatalogExpandedBytes = DEFAULT_MAX_CATALOG_EXPANDED_BYTES,
  createTemporaryId = randomUUID,
  renameFile = fs.rename,
} = {}) {
  const maxRetries = Math.max(0, Number(retries) || 0);
  const normalizedRetryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
  if (!catalogPath && !catalogOutputPath) {
    throw new Error('Downloader requires a local catalog path or a remote catalog output path.');
  }
  if (catalogPath && catalogOutputPath) {
    throw new Error('Downloader accepts either a local catalog path or a remote catalog output path, not both.');
  }
  if (!catalogOutputPath && snapshotManifestOutputPath) {
    throw new Error('Snapshot manifest output is available only with remote catalog output mode.');
  }
  const persistedOptionsOutputPath = catalogOutputPath
    ? (optionsOutputPath ?? path.join(path.dirname(catalogOutputPath), 'options.json'))
    : optionsOutputPath;
  const persistedSnapshotManifestOutputPath = catalogOutputPath
    ? (snapshotManifestOutputPath
      ?? path.join(path.dirname(catalogOutputPath), 'snapshot-manifest.json'))
    : null;
  const conceptualOutputPaths = [
    outputPath,
    persistedOptionsOutputPath,
    catalogOutputPath,
    persistedSnapshotManifestOutputPath,
  ].filter((output) => output !== null);
  if (conceptualOutputPaths.some((output) => typeof output !== 'string' || !output)) {
    throw new Error('Validated snapshot output paths must be non-empty strings.');
  }
  const resolvedConceptualOutputPaths = conceptualOutputPaths.map((output) => path.resolve(output));
  if (new Set(resolvedConceptualOutputPaths).size !== resolvedConceptualOutputPaths.length) {
    throw new Error('Validated snapshot output paths must be distinct.');
  }
  const optionsText = await fetchTextWithRetries({
    label: 'Options', url: optionsUrl, timeoutMs, accept: 'application/json',
    retries: maxRetries, retryDelayMs: normalizedRetryDelayMs
  });
  const options = parseOptionsJson(optionsText);

  let catalog;
  let catalogBytes = null;
  let catalogDownload = null;
  if (catalogOutputPath) {
    catalogDownload = parseCatalogDownloadDescriptor(options, {
      optionsUrl,
      maxCompressedBytes: maxCatalogCompressedBytes,
    });
    catalogBytes = await fetchCatalogBytes({
      url: catalogDownload.url,
      descriptor: catalogDownload,
      timeoutMs,
      retries: maxRetries,
      retryDelayMs: normalizedRetryDelayMs,
      maximumBytes: maxCatalogCompressedBytes,
    });
    catalog = await parseVerifiedCatalogArchive(catalogBytes, catalogDownload, {
      maxExpandedBytes: maxCatalogExpandedBytes,
    });
  } else {
    catalog = await loadCatalogForOptions(catalogPath, options, {
      maxCompressedBytes: maxCatalogCompressedBytes,
      maxExpandedBytes: maxCatalogExpandedBytes,
    });
  }
  validateOptionsCatalog({ options, catalog });

  const addonText = await fetchTextWithRetries({
    label: 'Addon data', url, timeoutMs, accept: 'text/plain',
    retries: maxRetries, retryDelayMs: normalizedRetryDelayMs
  });
  const validation = validateAddonContract({ addonText, options, catalog });
  const normalizedText = addonText.endsWith('\n') ? addonText : `${addonText}\n`;

  let previousHash = null;
  let previousAddonBytes = null;
  try {
    previousAddonBytes = await fs.readFile(outputPath);
    previousHash = addonDataHash(previousAddonBytes.toString('utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const nextHash = addonDataHash(normalizedText);
  const changed = previousHash === null || previousHash !== nextHash;
  const nextAddonBytes = Buffer.from(normalizedText, 'utf8');
  const persistedAddonBytes = changed ? nextAddonBytes : previousAddonBytes;
  if (!changed) {
    validateAddonContract({
      addonText: persistedAddonBytes.toString('utf8'),
      options,
      catalog,
    });
  }
  const replacements = [];
  if (persistedOptionsOutputPath) {
    replacements.push({ outputPath: persistedOptionsOutputPath, contents: optionsText });
  }
  if (catalogOutputPath) replacements.push({ outputPath: catalogOutputPath, contents: catalogBytes });
  if (changed) replacements.push({ outputPath, contents: normalizedText });
  if (persistedSnapshotManifestOutputPath) {
    replacements.push({
      outputPath: persistedSnapshotManifestOutputPath,
      contents: serializeReleaseInputSnapshotManifest({
        optionsBytes: Buffer.from(optionsText, 'utf8'),
        catalogBytes,
        addonBytes: persistedAddonBytes,
      }),
    });
  }
  if (replacements.length > 0) {
    await replaceValidatedFilesAtomically(replacements, { createTemporaryId, renameFile });
  }

  return {
    outputPath,
    bytes: Buffer.byteLength(normalizedText),
    emitted: validation.emitted,
    skipped: validation.skipped,
    partial: validation.skipped > 0,
    generatedAt: validation.data.generatedAt,
    catalogHash: validation.catalogHash,
    optionsOutputPath: persistedOptionsOutputPath,
    catalogOutputPath,
    snapshotManifestOutputPath: persistedSnapshotManifestOutputPath,
    catalogSha256: catalogDownload?.sha256 ?? null,
    changed,
    previousHash,
    hash: nextHash
  };
}

async function runCli() {
  const url = readArg('--url', process.env.QWT_ADDON_DATA_URL || DEFAULT_ADDON_URL);
  const optionsUrl = readArg('--options-url', process.env.QWT_OPTIONS_URL || DEFAULT_OPTIONS_URL);
  const optionsOutput = readArg('--options-output', process.env.QWT_ADDON_OPTIONS_OUTPUT_PATH || null);
  const optionsOutputPath = optionsOutput ? path.resolve(REPO_ROOT, optionsOutput) : null;
  const catalogOutput = readArg('--catalog-output', process.env.QWT_TALENT_CATALOG_OUTPUT_PATH || null);
  const catalogOutputPath = catalogOutput ? path.resolve(REPO_ROOT, catalogOutput) : null;
  const snapshotManifestOutput = readArg(
    '--snapshot-manifest-output',
    process.env.QWT_RELEASE_INPUT_MANIFEST_OUTPUT_PATH || null,
  );
  const snapshotManifestOutputPath = snapshotManifestOutput
    ? path.resolve(REPO_ROOT, snapshotManifestOutput)
    : null;
  const catalogInput = readArg(
    '--catalog',
    catalogOutputPath ? null : (process.env.QWT_TALENT_CATALOG_PATH || null),
  );
  const catalogPath = catalogInput ? path.resolve(REPO_ROOT, catalogInput) : null;
  if (!catalogPath && !catalogOutputPath) {
    throw new Error('CLI requires --catalog <local-path> or --catalog-output <remote-snapshot-path>.');
  }
  if (catalogPath && catalogOutputPath) {
    throw new Error('CLI accepts --catalog or --catalog-output, not both.');
  }
  const outputPath = path.resolve(REPO_ROOT, readArg('--output', DEFAULT_OUTPUT));
  const timeoutMs = Number(readArg('--timeout-ms', process.env.QWT_ADDON_DATA_TIMEOUT_MS || 45000));
  const retries = Number(readArg('--retries', process.env.QWT_ADDON_DATA_RETRIES || 0));
  const retryDelayMs = Number(readArg('--retry-delay-ms', process.env.QWT_ADDON_DATA_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS));
  const result = await downloadAddonData({
    url, optionsUrl, optionsOutputPath, catalogPath, catalogOutputPath,
    snapshotManifestOutputPath,
    outputPath, timeoutMs, retries, retryDelayMs
  });
  return {
    ok: true,
    source: url,
    optionsSource: optionsUrl,
    catalogPath: catalogPath ?? catalogOutputPath,
    ...result,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runCli(), null, 2));
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  }
}
