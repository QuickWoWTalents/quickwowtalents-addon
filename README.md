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

The addon only chooses between bundled strings. You still copy the string and import it through Blizzard's normal Talent Loadout UI.

Extra commands:

```text
/qwt info
/qwt hide
```

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

Automated release checks are scheduled daily at **15:30 UTC**, after the public Quick WoW Talents cache should be warm. A new release is published only when the bundled recommendation data actually changes.

## Data source and privacy

- Source data comes from cached Quick WoW Talents recommendations.
- The generated addon data is bundled into `QuickWoWTalentsData.lua`.
- The addon is fully static/offline in-game.
- No in-game network calls are made.
- No player data is uploaded by the addon.

## Known limitations

- Import strings can become stale after Blizzard talent-tree or interface changes. Update to the latest release first if an import fails.
- The addon displays/copies import strings; it does not directly create or modify talent loadouts.
- Current bundled recommendations focus on Quick WoW Talents' supported public recommendation set.

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

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Download the product-side generated addon data artifact:

```bash
npm run build:data:download
```

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

GitHub Actions runs `.github/workflows/daily-release.yml` every day at `15:30 UTC` and can also be started manually with **Run workflow**.

Manual runs default to a fast dry-run that generates one spec, runs checks, and packages locally without committing, tagging, or publishing. Set `dry_run=false` only when intentionally publishing a manual full release.

The pipeline:

1. downloads `QuickWoWTalentsData.lua` from the product-side addon data artifact at `quickwowtalents.com`
2. skips publishing if the bundled recommendation data is unchanged
3. bumps the addon patch version in `package.json` and `QuickWoWTalents.toc` when a release is needed
4. verifies scripts and tests
5. packages the addon zip
6. commits the generated data/version bump to `main`
7. creates a matching Git tag and GitHub release with the zip asset

No GitHub secrets are required beyond the built-in `GITHUB_TOKEN`.

## Support

Please open an issue with:

- addon version
- WoW client version
- class/spec
- what `/qwt info` shows
- the import error or behavior you saw

## License

Copyright (c) 2026 Darragh. All rights reserved.
