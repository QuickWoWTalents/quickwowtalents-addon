# WoW 12.1 Current-Only Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the addon downloader, runtime, package, and release workflow accept and publish only the current WoW 12.1 schema-3 recommendation snapshot.

**Architecture:** A small non-executing Lua reader parses the generated data contract. One validator compares it with product options and the hash-matched normalized talent catalog, including structural decoding of every import string. Release acquisition downloads the content-addressed catalog advertised by options, persists the verified options/catalog/add-on tuple, and commits its digest manifest last so later gates can re-hash the exact snapshot. Downloader, local fallback builder, release readiness, and workflow call the same contract before mutating or publishing anything; the game client adds an interface/schema gate.

**Tech Stack:** Node.js ESM, Node test runner, Lua addon runtime, GitHub Actions, zip/unzip.

**Spec:** `docs/specs/2026-08-25-wow121-current-only-addon-contract.md`

## Global Constraints

- Require schema 3, client interface `120100`, Raidbots `live`, WoW `12.1.x`, 40 specs, and a non-empty catalog content hash.
- Use the exact `talentCatalog` descriptor from product options and addon data; do not infer or rewrite identifiers.
- Counts are `specs`, `attempted`, `emitted`, `specsWithAnyRecommendation`, and `skipped`; `emitted + skipped` must equal `attempted`.
- Allow only `NO_USABLE_LOGS` and `NO_COMPATIBLE_CURRENT_LOGS` skips.
- Validate every import string against a normalized catalog whose hash equals `talentCatalog.contentHash`.
- Bind a remotely acquired catalog to the exact four-field `talentCatalogDownload` metadata and recheck its raw gzip length/SHA-256 from persisted inputs.
- Fail before replacing the bundled file when any validation fails.
- Runtime gates on schema and client interface, not exact hotfix build.
- Use TDD: observe each new behavior test fail before adding production code.

---

### Task 1: Parse Generated Lua Without Executing It

**Files:**

- Create: `scripts/parse-addon-lua.mjs`
- Create: `test/parse-addon-lua.test.mjs`

**Interfaces:**

- Produces `parseAddonLua(text): object` for the generated subset of Lua: tables, array entries, keyed entries, strings, finite numbers, booleans, and `nil`.
- Rejects functions, expressions, duplicate keys, trailing tokens, and any root other than `QuickWoWTalentsData = { ... }`.

- [ ] Write tests for a complete nested schema-3 fixture, escaped strings, numeric recommendation keys, duplicate keys, executable syntax, and trailing content.
- [ ] Run `node --test test/parse-addon-lua.test.mjs` and confirm module-not-found failure.
- [ ] Implement a tokenizer and recursive-descent reader scoped to generated addon Lua. Never use `eval`, `Function`, a Lua interpreter, or a regex-only parser.
- [ ] Re-run the focused test and commit as `Parse generated addon Lua safely`.

### Task 2: Central Schema and Catalog Validator

**Files:**

- Create: `scripts/validate-addon-contract.mjs`
- Create: `test/validate-addon-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces `validateAddonContract({ addonText, options, catalog }): { data, catalogHash, emitted, skipped }`.
- Produces `loadNormalizedCatalog(filePath)` for `talent-trees.json` and `.json.gz`.
- Produces `validateImportStringForSpec(importString, specRecord)` using Blizzard loadout bit decoding.

- [ ] Add failing tests for schema 2, wrong interface/build/environment/spec count/hash, activity-order mismatch, bad counts, unknown skips, empty strings, unknown talent IDs, truncated strings, and a valid partial bundle using both safe skip codes.
- [ ] Run `node --test test/validate-addon-contract.test.mjs` and confirm missing-module failure.
- [ ] Implement exact descriptor equality between parsed addon data and options, ordered activity equality, count/matrix checks, safe-gap checks, catalog-file SHA agreement, and structural decoding against each recommendation's spec.
- [ ] Add `validate:data` to `package.json`; re-run the focused test and commit as `Validate schema 3 addon data against current talents`.

### Task 3: Fail-Closed Product Downloader

**Files:**

- Modify: `scripts/download-addon-data.mjs`
- Modify: `test/download-addon-data.test.mjs`
- Modify: `README.md`

**Interfaces:**

- `downloadAddonData()` fetches `/api/options`, its same-origin content-addressed catalog gzip, and the addon artifact; explicit local `catalogPath` remains available for offline verification.
- The output file is written atomically only after `validateAddonContract()` succeeds.

- [ ] Add failing tests proving all production inputs are fetched, download metadata/raw gzip/descriptors/activities reject on mismatch, validation failures preserve existing files byte-for-byte, and valid safe gaps report `emitted`/`skipped`.
- [ ] Run `node --test test/download-addon-data.test.mjs` and observe the schema-2 downloader behavior fail.
- [ ] Replace duplicated brace/count checks with the shared parser/validator, use exclusive temporary sibling files plus rename, and expose remote `--catalog-output` plus explicit offline `--catalog`.
- [ ] Re-run the focused test and commit as `Download only verified current addon data`.

### Task 4: Schema-3 Fallback Builder and Runtime Gate

**Files:**

- Modify: `scripts/build-data.mjs`
- Modify: `test/build-data.test.mjs`
- Modify: `QuickWoWTalents.lua`
- Modify: `test/auto-open.test.mjs`
- Modify: `test/copy-close.test.mjs`

**Interfaces:**

- Strict local generation emits the same schema-3 descriptor, activities, counts, skip policy, and exact raid selection as the product artifact.
- Runtime exposes no recommendation when `schemaVersion !== 3` or `clientInterface !== select(4, GetBuildInfo())`.

- [ ] Add failing builder tests for schema 3, `talentCatalog`, ordered activities, `emitted`, safe gaps, `bestOverallMinKeystoneLevel=15`, and `exactSelection=true` on raid requests.
- [ ] Add failing Lua harness tests for valid interface, schema mismatch, interface mismatch, the update-required message, and absence of `mplusBestOverall` fallback.
- [ ] Run `node --test test/build-data.test.mjs test/auto-open.test.mjs test/copy-close.test.mjs` and confirm current schema/runtime behavior fails.
- [ ] Implement the contract and gate copy/apply/UI entry points through one `GetDataCompatibilityError()` helper. Remove the legacy fallback.
- [ ] Re-run focused tests and commit as `Gate addon recommendations on schema and interface`.

### Task 5: Verify Source and Packaged Data

**Files:**

- Modify: `scripts/verify-release-readiness.mjs`
- Modify: `test/verify-release-readiness.test.mjs`
- Modify: `scripts/package-addon.mjs`
- Modify: `test/prepare-release.test.mjs`

**Interfaces:**

- `verifyReleaseReadiness({ repoRoot, optionsPath, catalogPath, snapshotManifestPath, skipZip })` applies the shared contract to both source `QuickWoWTalentsData.lua` and the zip entry after re-hashing the persisted tuple.
- Release preparation remains a version/changelog operation and cannot make stale data appear ready.

- [ ] Add failing fixtures where source is valid but zip data differs, the zip is schema 2, or source catalog hash is stale; retain positive interface/version/changelog coverage.
- [ ] Run `node --test test/verify-release-readiness.test.mjs test/prepare-release.test.mjs` and confirm invalid data is currently accepted.
- [ ] Validate source before archive checks, then validate zip data independently against the same options snapshot/catalog fixture. Report `source-data-contract` and `zip-data-contract` checks.
- [ ] Re-run focused tests, run `npm test`, and commit as `Verify addon data inside release archives`.

### Task 6: Release Workflow Ordering and Schedule

**Files:**

- Modify: `.github/workflows/daily-release.yml`
- Modify: `.github/workflows/pull-request.yml`
- Modify: `RELEASING.md`
- Modify: `README.md`
- Create: `test/workflow-contract.test.mjs`

**Interfaces:**

- Scheduled release is `30 17 * * *` UTC.
- Workflow obtains the production-hash-matched normalized catalog from the same-origin content-addressed endpoint advertised by options. Each workflow uses exactly one add-on checkout with no repository override.
- Version preparation occurs only after data validation and tests; publish occurs only after packaging and readiness verification.

- [ ] Add a failing workflow test for the exact cron, credential-free catalog acquisition/input persistence, validation-before-version order, package-before-readiness order, and readiness-before-publish order.
- [ ] Run `node --test test/workflow-contract.test.mjs` and confirm the old schedule/order fails.
- [ ] Update both workflows and release documentation. Keep manual dry-run non-publishing and tag-exists protection.
- [ ] Run the workflow test, `npm test`, `npm run package`, `npm run release:verify`, `git diff --check`, and commit as `Gate addon releases on current production data`.

### Task 7: Regenerate the Release Snapshot

**Files:**

- Modify: `QuickWoWTalentsData.lua`

- [ ] After the production schema-3 deployment is live and cache warming is complete, download using production `/api/options`, its advertised content-addressed catalog gzip, and `/api/addon-data`.
- [ ] Run `npm run validate:data`, `npm test`, `npm run package`, and `npm run release:verify`.
- [ ] Confirm the bundled data reports schema 3/interface 120100, exact production catalog hash/activity IDs, only allowed safe skips, and no structural decoder failures.
- [ ] Commit as `Bundle current WoW 12.1 recommendations`.
