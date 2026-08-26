import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { runReadinessCli, verifyReleaseReadiness } from '../scripts/verify-release-readiness.mjs';

const execFileAsync = promisify(execFile);
const readinessPath = fileURLToPath(new URL('../scripts/verify-release-readiness.mjs', import.meta.url));
const CATALOG_DESCRIPTOR = {
  source: 'raidbots',
  environment: 'live',
  generatedAt: '2026-08-20T20:24:24.981Z',
  wowBuild: '12.1.0.69404',
  contentHash: 'release-readiness-catalog-hash',
  clientInterface: 120100,
  specCount: 40,
};

function makeCatalog() {
  const specs = {};
  for (let index = 0; index < 40; index += 1) {
    const className = `Test Class ${index + 1}`;
    const specName = `Spec ${index + 1}`;
    const specId = 1001 + index;
    specs[`${className}:${specName}`] = { specId, className, specName };
  }
  return {
    source: CATALOG_DESCRIPTOR.source,
    environment: CATALOG_DESCRIPTOR.environment,
    generatedAt: CATALOG_DESCRIPTOR.generatedAt,
    wowBuild: CATALOG_DESCRIPTOR.wowBuild,
    contentHash: CATALOG_DESCRIPTOR.contentHash,
    specs,
  };
}

function makeOptions() {
  return {
    talentCatalog: structuredClone(CATALOG_DESCRIPTOR),
    mythicPlus: {
      expansionId: 11,
      zoneId: 51,
      dungeons: [
        { id: 12993, name: 'Windrunner Spire' },
        { id: 12825, name: 'Maisara Caverns' },
      ],
    },
    raid: {
      expansionId: 11,
      zoneId: 50,
      bosses: [{ id: 3159, name: 'Rotmire', raidName: 'Sporefall', zoneId: 50 }],
      difficulties: [{ id: 4, name: 'Heroic' }],
    },
  };
}

function makeAddonData(catalog) {
  const skipped = [];
  for (const [key, spec] of Object.entries(catalog.specs)) {
    for (const [mode, encounterIds] of [
      ['mplus', [12993, 12825]],
      ['raid', [3159]],
    ]) {
      for (const encounterId of encounterIds) {
        skipped.push({
          key,
          specId: spec.specId,
          className: spec.className,
          specName: spec.specName,
          mode,
          encounterId,
          encounterName: `Encounter ${encounterId}`,
          code: 'NO_USABLE_LOGS',
          reason: 'No usable current logs.',
        });
      }
    }
  }

  return {
    schemaVersion: 3,
    source: 'https://quickwowtalents.com',
    generatedAt: '2026-08-25T12:00:00.000Z',
    clientInterface: 120100,
    talentCatalog: structuredClone(CATALOG_DESCRIPTOR),
    activities: {
      mythicPlus: { expansionId: 11, zoneId: 51, dungeonIds: [12993, 12825] },
      raid: {
        expansionId: 11,
        primaryZoneId: 50,
        difficultyId: 4,
        zones: [{ zoneId: 50, name: 'Sporefall', bossIds: [3159] }],
        bossIds: [3159],
      },
    },
    counts: {
      specs: 40,
      attempted: 120,
      emitted: 0,
      specsWithAnyRecommendation: 0,
      skipped: 120,
    },
    recommendations: {},
    skipped,
  };
}

function toLua(value, indent = 0) {
  if (value === null) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const entries = Array.isArray(value)
    ? value.map((item) => ({ key: null, value: item }))
    : Object.entries(value).map(([key, item]) => ({ key, value: item }));
  if (entries.length === 0) return '{}';

  const padding = ' '.repeat(indent + 2);
  const closingPadding = ' '.repeat(indent);
  const rendered = entries.map((entry) => {
    let key = '';
    if (entry.key !== null) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key)) key = `${entry.key} = `;
      else if (/^[1-9]\d*$/.test(entry.key)) key = `[${entry.key}] = `;
      else key = `[${JSON.stringify(entry.key)}] = `;
    }
    return `${padding}${key}${toLua(entry.value, indent + 2)}`;
  });
  return `{\n${rendered.join(',\n')}\n${closingPadding}}`;
}

function renderAddonData(data) {
  return `-- Generated readiness fixture.\nQuickWoWTalentsData = ${toLua(data)}\n`;
}

async function writeSnapshotManifest(manifestPath, { addonPath, optionsPath, catalogPath }) {
  const [addonBytes, optionsBytes, catalogBytes] = await Promise.all([
    fs.readFile(addonPath),
    fs.readFile(optionsPath),
    fs.readFile(catalogPath),
  ]);
  const record = (bytes) => ({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    files: {
      options: record(optionsBytes),
      catalog: record(catalogBytes),
      addon: record(addonBytes),
    },
  })}\n`);
}

async function writeFixture({
  packageVersion = '1.2.3',
  tocVersion = '1.2.3',
  scopedChangelog = 'QuickWoWTalents 1.2.3 - 2026-05-25\n\n- Updated bundled recommendation data from quickwowtalents.com.\n',
  packageMeta = 'manual-changelog:\n  filename: CURSEFORGE_CHANGELOG.md\n  markup-type: plain\n',
  zipTocVersion = '1.2.3',
  tocInterface = '120100, 120007, 120005',
  zipTocInterface = tocInterface,
  includeZip = true,
  mutateSourceData = () => {},
  mutateZipData = () => {},
  packagedAddonLuaName = 'QuickWoWTalents.lua',
  packagedAddonLuaSymlink = false,
} = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwt-addon-readiness-'));
  const optionsPath = path.join(repoRoot, 'options.json');
  const catalogPath = path.join(repoRoot, 'talent-trees.json');
  const snapshotManifestPath = path.join(repoRoot, 'snapshot-manifest.json');
  const catalog = makeCatalog();
  const sourceData = makeAddonData(catalog);
  const zipData = structuredClone(sourceData);
  mutateSourceData(sourceData);
  mutateZipData(zipData);

  await fs.mkdir(path.join(repoRoot, 'dist'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'quickwowtalents-addon', version: packageVersion }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(repoRoot, 'QuickWoWTalents.toc'), `## Interface: ${tocInterface}\n## Version: ${tocVersion}\n`, 'utf8');
  await fs.writeFile(path.join(repoRoot, 'QuickWoWTalents.lua'), '-- addon\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'QuickWoWTalentsData.lua'), renderAddonData(sourceData), 'utf8');
  await fs.writeFile(optionsPath, JSON.stringify(makeOptions()), 'utf8');
  await fs.writeFile(catalogPath, JSON.stringify(catalog), 'utf8');
  await fs.writeFile(
    path.join(repoRoot, 'CHANGELOG.md'),
    `# QuickWoWTalents Changelog\n\n## Unreleased\n\n## ${packageVersion} - 2026-05-25\n\n- Updated bundled recommendation data from quickwowtalents.com.\n\n## 1.2.2\n\nPrevious.\n`,
    'utf8',
  );
  await fs.writeFile(path.join(repoRoot, 'CURSEFORGE_CHANGELOG.md'), scopedChangelog, 'utf8');
  await fs.writeFile(path.join(repoRoot, '.pkgmeta'), packageMeta, 'utf8');
  await writeSnapshotManifest(snapshotManifestPath, {
    addonPath: path.join(repoRoot, 'QuickWoWTalentsData.lua'),
    optionsPath,
    catalogPath,
  });

  if (includeZip) {
    const stagingRoot = path.join(repoRoot, 'stage');
    const addonDir = path.join(stagingRoot, 'QuickWoWTalents');
    await fs.mkdir(addonDir, { recursive: true });
    await fs.writeFile(path.join(addonDir, 'QuickWoWTalents.toc'), `## Interface: ${zipTocInterface}\n## Version: ${zipTocVersion}\n`, 'utf8');
    if (packagedAddonLuaSymlink) {
      await fs.symlink('QuickWoWTalentsData.lua', path.join(addonDir, packagedAddonLuaName));
    } else {
      await fs.writeFile(path.join(addonDir, packagedAddonLuaName), '-- addon\n', 'utf8');
    }
    await fs.writeFile(path.join(addonDir, 'QuickWoWTalentsData.lua'), renderAddonData(zipData), 'utf8');
    const zipFlags = packagedAddonLuaSymlink ? '-qry' : '-qr';
    await execFileAsync('zip', [zipFlags, path.join(repoRoot, 'dist', `QuickWoWTalents-${packageVersion}.zip`), 'QuickWoWTalents'], {
      cwd: stagingRoot,
    });
  }

  return { repoRoot, optionsPath, catalogPath, snapshotManifestPath };
}

test('verifyReleaseReadiness accepts independently valid matching source and packaged data', async () => {
  const fixture = await writeFixture();
  const zipBytes = await fs.readFile(path.join(fixture.repoRoot, 'dist', 'QuickWoWTalents-1.2.3.zip'));
  const result = await verifyReleaseReadiness(fixture);

  assert.deepEqual(result, {
    ok: true,
    version: '1.2.3',
    zipPath: path.join(fixture.repoRoot, 'dist', 'QuickWoWTalents-1.2.3.zip'),
    zipSha256: createHash('sha256').update(zipBytes).digest('hex'),
    checks: [
      'package-version',
      'toc-version',
      'toc-interface',
      'pkgmeta-changelog',
      'scoped-curseforge-changelog',
      'historical-changelog',
      'release-input-snapshot',
      'source-data-contract',
      'zip-exists',
      'zip-payload',
      'zip-toc-version',
      'zip-toc-interface',
      'zip-data-contract',
      'source-zip-data-match',
    ],
  });
});

test('verifyReleaseReadiness accepts a catalog gzip exactly bound to persisted options', async () => {
  const fixture = await writeFixture();
  const catalog = JSON.parse(await fs.readFile(fixture.catalogPath, 'utf8'));
  const options = JSON.parse(await fs.readFile(fixture.optionsPath, 'utf8'));
  const catalogBytes = gzipSync(JSON.stringify(catalog));
  const sha256 = createHash('sha256').update(catalogBytes).digest('hex');
  options.talentCatalogDownload = {
    path: `/api/talent-catalog?sha256=${sha256}`,
    sha256,
    bytes: catalogBytes.length,
    mediaType: 'application/gzip',
  };
  const catalogPath = path.join(fixture.repoRoot, 'talent-catalog.json.gz');
  await Promise.all([
    fs.writeFile(fixture.optionsPath, JSON.stringify(options)),
    fs.writeFile(catalogPath, catalogBytes),
  ]);
  await writeSnapshotManifest(fixture.snapshotManifestPath, {
    addonPath: path.join(fixture.repoRoot, 'QuickWoWTalentsData.lua'),
    optionsPath: fixture.optionsPath,
    catalogPath,
  });

  const result = await verifyReleaseReadiness({
    ...fixture,
    catalogPath,
    requireCatalogDownload: true,
  });
  assert.equal(result.ok, true);
  assert.match(result.zipSha256, /^[0-9a-f]{64}$/);
});

test('verifyReleaseReadiness rejects catalog gzip bytes not bound to persisted options', async () => {
  const fixture = await writeFixture();
  const catalog = JSON.parse(await fs.readFile(fixture.catalogPath, 'utf8'));
  const options = JSON.parse(await fs.readFile(fixture.optionsPath, 'utf8'));
  const catalogText = JSON.stringify(catalog);
  const expectedBytes = gzipSync(catalogText, { level: 9 });
  const persistedBytes = gzipSync(catalogText, { level: 1 });
  assert.notDeepEqual(persistedBytes, expectedBytes);
  const sha256 = createHash('sha256').update(expectedBytes).digest('hex');
  options.talentCatalogDownload = {
    path: `/api/talent-catalog?sha256=${sha256}`,
    sha256,
    bytes: expectedBytes.length,
    mediaType: 'application/gzip',
  };
  const catalogPath = path.join(fixture.repoRoot, 'talent-catalog.json.gz');
  await Promise.all([
    fs.writeFile(fixture.optionsPath, JSON.stringify(options)),
    fs.writeFile(catalogPath, persistedBytes),
  ]);
  await writeSnapshotManifest(fixture.snapshotManifestPath, {
    addonPath: path.join(fixture.repoRoot, 'QuickWoWTalentsData.lua'),
    optionsPath: fixture.optionsPath,
    catalogPath,
  });

  await assert.rejects(
    verifyReleaseReadiness({
      ...fixture,
      catalogPath,
      requireCatalogDownload: true,
    }),
    /catalog.*(?:SHA-256|byte length)/i,
  );
});

test('verifyReleaseReadiness requires the commit marker and rejects a stale exact tuple', async () => {
  const fixture = await writeFixture({ includeZip: false });
  const { snapshotManifestPath, ...withoutManifest } = fixture;
  await assert.rejects(
    verifyReleaseReadiness({ ...withoutManifest, skipZip: true }),
    /requires snapshotManifestPath/i,
  );

  await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  for (const target of ['options', 'catalog', 'addon']) {
    const staleFixture = await writeFixture({ includeZip: false });
    const targetPath = target === 'options'
      ? staleFixture.optionsPath
      : target === 'catalog'
        ? staleFixture.catalogPath
        : path.join(staleFixture.repoRoot, 'QuickWoWTalentsData.lua');
    try {
      await fs.appendFile(targetPath, '\n');
      await assert.rejects(
        verifyReleaseReadiness({ ...staleFixture, skipZip: true }),
        new RegExp(`release input snapshot.*${target} byte length`, 'i'),
      );
    } finally {
      await fs.rm(staleFixture.repoRoot, { recursive: true, force: true });
    }
  }
});

test('verifyReleaseReadiness validates one captured archive snapshot after its path disappears', async () => {
  const fixture = await writeFixture();
  const zipPath = path.join(fixture.repoRoot, 'dist', 'QuickWoWTalents-1.2.3.zip');
  const capturedBytes = await fs.readFile(zipPath);

  const result = await verifyReleaseReadiness({
    ...fixture,
    async archiveSnapshotReader(archivePath) {
      const bytes = await fs.readFile(archivePath);
      await fs.unlink(archivePath);
      return bytes;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.zipSha256, createHash('sha256').update(capturedBytes).digest('hex'));
  await assert.rejects(fs.access(zipPath), /ENOENT/);
});

test('verifyReleaseReadiness rejects package and TOC version drift', async () => {
  const fixture = await writeFixture({ tocVersion: '1.2.2' });
  await assert.rejects(verifyReleaseReadiness(fixture), /package\.json version 1\.2\.3 does not match QuickWoWTalents\.toc version 1\.2\.2/);
});

test('verifyReleaseReadiness rejects noisy CurseForge changelogs', async () => {
  const fixture = await writeFixture({ scopedChangelog: 'QuickWoWTalents 1.2.3 - 2026-05-25\n\n- Current.\n\n## 1.2.2\n\n- Older release.\n' });
  await assert.rejects(verifyReleaseReadiness(fixture), /CURSEFORGE_CHANGELOG\.md must contain only the current version notes/);
});

test('verifyReleaseReadiness rejects zipped TOC version drift', async () => {
  const fixture = await writeFixture({ zipTocVersion: '1.2.2' });
  await assert.rejects(verifyReleaseReadiness(fixture), /packaged QuickWoWTalents\.toc version 1\.2\.2 does not match package\.json version 1\.2\.3/);
});

test('verifyReleaseReadiness rejects releases missing the current retail interface', async () => {
  const fixture = await writeFixture({ tocInterface: '120005, 120001' });
  await assert.rejects(verifyReleaseReadiness(fixture), /QuickWoWTalents\.toc must include interface 120100/);
});

test('verifyReleaseReadiness rejects packaged releases missing the current retail interface', async () => {
  const fixture = await writeFixture({ zipTocInterface: '120005, 120001' });
  await assert.rejects(verifyReleaseReadiness(fixture), /packaged QuickWoWTalents\.toc must include interface 120100/);
});

test('verifyReleaseReadiness rejects a stale source catalog hash before checking for the zip', async () => {
  const fixture = await writeFixture({
    includeZip: false,
    mutateSourceData(data) {
      data.talentCatalog.contentHash = 'stale-source-hash';
    },
  });
  await assert.rejects(verifyReleaseReadiness(fixture), /source data contract.*contentHash/i);
});

test('verifyReleaseReadiness rejects valid packaged data whose bytes differ from source', async () => {
  const fixture = await writeFixture({
    mutateZipData(data) {
      data.generatedAt = '2026-08-25T12:00:01.000Z';
    },
  });
  await assert.rejects(verifyReleaseReadiness(fixture), /packaged QuickWoWTalentsData\.lua does not match source QuickWoWTalentsData\.lua/);
});

test('verifyReleaseReadiness rejects schema-2 data inside the zip independently', async () => {
  const fixture = await writeFixture({
    mutateZipData(data) {
      data.schemaVersion = 2;
    },
  });
  await assert.rejects(verifyReleaseReadiness(fixture), /zip data contract.*schema 3/i);
});

test('verifyReleaseReadiness rejects a ZIP member hidden by trailing whitespace', async () => {
  const fixture = await writeFixture({ packagedAddonLuaName: 'QuickWoWTalents.lua ' });
  await assert.rejects(verifyReleaseReadiness(fixture), /exactly.*QuickWoWTalents\.lua|unexpected ZIP member/i);
});

test('verifyReleaseReadiness rejects a ZIP member hidden by a control character', async () => {
  const fixture = await writeFixture({ packagedAddonLuaName: 'QuickWoWTalents.lua\n' });
  await assert.rejects(verifyReleaseReadiness(fixture), /exactly.*QuickWoWTalents\.lua|unexpected ZIP member/i);
});

test('verifyReleaseReadiness rejects a symlink with an allowed ZIP member name', async () => {
  const fixture = await writeFixture({ packagedAddonLuaSymlink: true });
  await assert.rejects(verifyReleaseReadiness(fixture), /regular file|symlink/i);
});

test('verifyReleaseReadiness skipZip skips only archive checks', async () => {
  const fixture = await writeFixture({ includeZip: false });
  const result = await verifyReleaseReadiness({ ...fixture, skipZip: true });

  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.3');
  assert.match(result.checks.join(','), /source-data-contract/);
  assert.doesNotMatch(result.checks.join(','), /zip/);
});

test('verifyReleaseReadiness skipZip still rejects invalid source data', async () => {
  const fixture = await writeFixture({
    includeZip: false,
    mutateSourceData(data) {
      data.schemaVersion = 2;
    },
  });
  await assert.rejects(verifyReleaseReadiness({ ...fixture, skipZip: true }), /source data contract.*schema 3/i);
});

test('readiness CLI runner succeeds with explicit persisted paths in an isolated repository', async () => {
  const fixture = await writeFixture({ includeZip: false });
  const result = await runReadinessCli({
    args: [
      '--options', fixture.optionsPath,
      '--catalog', fixture.catalogPath,
      '--snapshot-manifest', fixture.snapshotManifestPath,
      '--skip-zip',
    ],
    env: {},
    repoRoot: fixture.repoRoot,
  });

  assert.equal(result.ok, true);
  assert.match(result.checks.join(','), /source-data-contract/);
});

test('readiness CLI runner succeeds with named environment paths in an isolated repository', async () => {
  const fixture = await writeFixture({ includeZip: false });
  const result = await runReadinessCli({
    args: ['--skip-zip'],
    env: {
      QWT_ADDON_OPTIONS_PATH: fixture.optionsPath,
      QWT_TALENT_CATALOG_PATH: fixture.catalogPath,
      QWT_RELEASE_INPUT_MANIFEST_PATH: fixture.snapshotManifestPath,
    },
    repoRoot: fixture.repoRoot,
  });

  assert.equal(result.ok, true);
});

test('readiness CLI fails closed without options and catalog paths', async () => {
  const fixture = await writeFixture({ includeZip: false });
  const env = { ...process.env };
  delete env.QWT_ADDON_OPTIONS_PATH;
  delete env.QWT_TALENT_CATALOG_PATH;
  delete env.QWT_RELEASE_INPUT_MANIFEST_PATH;

  await assert.rejects(
    execFileAsync(process.execPath, [readinessPath, '--skip-zip'], { cwd: fixture.repoRoot, env }),
    /requires --options.*QWT_ADDON_OPTIONS_PATH/i,
  );
});
