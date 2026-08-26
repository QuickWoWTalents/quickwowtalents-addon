# Quick WoW Talents Addon

Offline World of Warcraft addon for [Quick WoW Talents](https://quickwowtalents.com) import strings.

The addon bundles current recommended talent import strings from Quick WoW Talents and shows the best match for your current specialization in-game. It does **not** call Warcraft Logs, Quick WoW Talents, or any external service from inside WoW.

## What it does

Run:

```text
/qwt
```

The addon detects your current specialization and opens a small selector with:

- mode dropdown: **Mythic+** or **Heroic Raid**
- encounter dropdown:
  - Mythic+: dungeon selector plus **Best Overall**
  - Raid: current Heroic raid boss selector
- copyable Blizzard talent import string

When you enter a supported Mythic+ dungeon and the bundle has a build for your current specialization, the addon automatically opens the matching dungeon recommendation once. It waits briefly after zoning so WoW's instance APIs can settle, never opens during combat, and will not keep reopening after you close it for the current instance context.

The addon only chooses between bundled strings. You still copy the string and import it through Blizzard's normal Talent Loadout UI.

Extra commands:

```text
/qwt info
/qwt hide
/qwt auto status
/qwt auto on
/qwt auto off
```

Automatic opening is enabled by default. Use `/qwt auto off` if you prefer fully manual `/qwt` behavior.

## Install

1. Download the latest `QuickWoWTalents-<version>.zip` from the [GitHub releases page](https://github.com/QuickWoWTalents/quickwowtalents-addon/releases).
2. Extract the zip into your retail AddOns directory:

   ```text
   World of Warcraft/_retail_/Interface/AddOns/
   ```

3. Confirm the folder structure looks like this:

   ```text
   World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents/QuickWoWTalents.toc
   World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents/QuickWoWTalents.lua
   World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents/QuickWoWTalentsData.lua
   ```

4. Restart WoW or run:

   ```text
   /reload
   ```

5. Run:

   ```text
   /qwt
   ```

## Updating

Install the newest zip from [Releases](https://github.com/QuickWoWTalents/quickwowtalents-addon/releases) over the existing `QuickWoWTalents` folder.

Automated release checks are scheduled daily at **17:30 UTC**, after the production warm and monitor window. A scheduled release is published only when the fully validated recommendation data actually changes.

## Data source and privacy

- Source data comes from cached Quick WoW Talents recommendations.
- The generated addon data is bundled into `QuickWoWTalentsData.lua`.
- The addon is fully static/offline in-game.
- No in-game network calls are made.
- No player data is uploaded by the addon.
- Automatic Mythic+ opening only reads local WoW client context APIs such as current specialization, instance state, and current challenge map.

## Known limitations

- Import strings can become stale after Blizzard talent-tree or interface changes. Update to the latest release first if an import fails.
- The addon displays/copies import strings; it does not directly create or modify talent loadouts.
- Current bundled recommendations focus on Quick WoW Talents' supported public recommendation set.
- Automatic opening currently targets Mythic+ only. Raid recommendations remain available through the manual selector because exact boss context is not reliably known before pull.
- Automatic Mythic+ matching depends on the current season's client dungeon IDs. Unsupported or future dungeons simply fall back to manual `/qwt` behavior.

## Repository layout

The addon source files live at the repository root on purpose:

```text
QuickWoWTalents.toc
QuickWoWTalents.lua
QuickWoWTalentsData.lua
```

This matches established CurseForge-packaged addon repositories and lets CurseForge automatic packaging put those files into the final `QuickWoWTalents/` addon folder via `.pkgmeta`.

## Local development

Requirements:

- Node.js 20+
- `zip` or macOS `ditto` for packaging

Install locked dependencies:

```bash
npm ci
```

Run tests:

```bash
npm test
```

Download and validate one production options/catalog/artifact snapshot, while persisting the exact options and content-addressed catalog inputs for later readiness checks:

```bash
npm run build:data:download -- \
  --options-output /tmp/quickwowtalents-release-options.json \
  --catalog-output /tmp/quickwowtalents-release-catalog.json.gz \
  --snapshot-manifest-output /tmp/quickwowtalents-release-snapshot-manifest.json
```

Production `/api/options` supplies `talentCatalogDownload` with exactly `path`, `sha256`, `bytes`, and `mediaType`. The downloader accepts only the same-origin HTTPS `/api/talent-catalog?sha256=<sha>` path, raw `application/gzip` bytes with no content encoding, the declared compressed length and SHA-256, and bounded compressed/expanded sizes. It rejects redirects, parses and descriptor-checks that gzip, and then fetches add-on data. After all three inputs validate, it stages the exact options, catalog, and add-on outputs, commits each with an atomic rename, and writes the snapshot manifest last. That strict version-1 manifest records the SHA-256 and byte length of the exact three persisted files. Validation and readiness require and re-hash the manifest tuple, so an interrupted commit or deployment lag fails closed.

For explicit local/offline verification, `--catalog /path/to/talent-trees.json.gz` (or `.json`) remains supported instead of `--catalog-output`. Local mode validates the parsed catalog descriptor and import strings against options but does not claim that a JSON file or independently recompressed gzip has the production archive's exact bytes.

The production endpoints default to `https://quickwowtalents.com/api/addon-data` and `https://quickwowtalents.com/api/options`. Override downloader inputs when needed:

```bash
npm run build:data:download -- \
  --catalog /path/to/talent-trees.json \
  --url https://example.test/api/addon-data \
  --options-url https://example.test/api/options \
  --options-output /path/to/options.json \
  --output /path/to/QuickWoWTalentsData.lua
```

Equivalent environment variables are `QWT_TALENT_CATALOG_PATH` for an explicit local input, `QWT_TALENT_CATALOG_OUTPUT_PATH` for a remote catalog destination, `QWT_RELEASE_INPUT_MANIFEST_OUTPUT_PATH`, `QWT_ADDON_DATA_URL`, `QWT_OPTIONS_URL`, and `QWT_ADDON_OPTIONS_OUTPUT_PATH`. Validation and readiness accept `QWT_RELEASE_INPUT_MANIFEST_PATH` for the committed marker. Retry controls remain available through `--retries`, `--retry-delay-ms`, and `--timeout-ms` (or their existing `QWT_ADDON_DATA_*` environment variables).

Generate data from individual cached public build payloads instead:

```bash
npm run build:data
```

Quick small test export for one spec:

```bash
node scripts/build-data.mjs --spec "Warlock:Demonology" --delay-ms 1200
```

Package a release zip:

```bash
npm run package
```

Creates:

```text
dist/QuickWoWTalents-<package-version>.zip
```

## Daily release pipeline

GitHub Actions runs `.github/workflows/daily-release.yml` every day at `17:30 UTC` (`30 17 * * *`) and can also be started manually with **Run workflow**. Both release and pull-request workflows use Node.js 22 with `npm ci`.

Manual runs default to a non-publishing dry-run. A dry-run still downloads the full production options/catalog/artifact snapshot, runs tests, packages, and performs source/ZIP readiness; it may be run from a non-`main` ref because publication is unreachable. Set `dry_run=false` only when intentionally publishing a manual full release from `refs/heads/main`. Manual full releases may continue when data is unchanged, but never bypass a gate or the fresh remote-`main` identity check.

The pipeline:

1. checks out only the add-on repository, without persisting checkout credentials
2. downloads production `/api/options`, its same-origin content-addressed catalog gzip, and `/api/addon-data`; persists the exact options/catalog/add-on tuple and writes its snapshot manifest last
3. requires the snapshot manifest, re-hashes and validates the source tuple, checks script syntax, and runs all tests
4. requires every publishing event to be the current remote `refs/heads/main`, then compares generated data with committed `HEAD`; scheduled runs skip when it is unchanged, while a manual full release may continue
5. prepares version/changelog files and rejects an existing local or remote tag
6. packages the add-on ZIP
7. re-hashes the same manifest-bound inputs, validates source and packaged data against them, and captures readiness `zipSha256`
8. commits and tags only after readiness, then re-hashes the exact final ZIP, authenticates Git only for publication, atomically pushes fully qualified `main` and tag refs, and creates the release only after verifying the remote tag exists

The pull-request workflow runs the same production schema/catalog/source/package/readiness checks with read-only permissions and never publishes. Each workflow has exactly one add-on checkout with no repository override. A production deployment lag fails closed because the options download descriptor, raw catalog gzip, parsed catalog descriptor, artifact, and snapshot manifest must agree. No GitHub secrets are required beyond the built-in `GITHUB_TOKEN` used only by the final publishing step.

See [RELEASING.md](RELEASING.md) for the exact production prerequisites and manual release order.

## Support

Please open an issue with:

- addon version
- WoW client version
- class/spec
- what `/qwt info` shows
- the import error or behavior you saw

## License

Copyright (c) 2026 Darragh. All rights reserved.
