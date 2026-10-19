# Quick WoW Talents Addon

Offline World of Warcraft addon for [Quick WoW Talents](https://quickwowtalents.com) recommendations and one-click talent imports.

The current retail compatibility target is **WoW 12.1.5** (Interface `120105`). Each release requires recommendation data validated against the matching live talent catalog.

The addon bundles current recommended talent import strings from Quick WoW Talents and shows the best match for your current specialization in-game. It does **not** call Warcraft Logs, Quick WoW Talents, or any external service from inside WoW.

## What it does

Run:

```text
/qwt
```

The addon detects your current specialization and opens a small selector with:

- mode dropdown: **Mythic+** or **Raid**
- encounter dropdown:
  - Mythic+: dungeon selector plus **Best Overall**
  - Raid: current raid boss selector
- **Add & Use Build** to save and apply the selected talents
- **Copy Build** for manual importing

When you enter a supported Mythic+ dungeon and the bundle has a build for your current specialization, the addon automatically opens the matching dungeon recommendation once. It waits briefly after zoning so WoW's instance APIs can settle, never opens during combat, and will not keep reopening after you close it for the current instance context.

Click **Add & Use Build** to create `QWT-<dungeon or boss>` and apply its talents with shared action bars. Once the new build is verified, the addon removes older `QWT-` loadouts across this character's specializations. It also cleans up legacy `QWT` and `QWTTest-` names. Personally named loadouts are preserved.

The import works with Blizzard's Talents window open or closed. Incomplete talents and pending edits are replaced by the selected build. The compact window shows talent application cast progress, uses matching dropdown menus, and supports optional EllesmereUI styling.

Extra commands:

```text
/qwt info
/qwt hide
/qwt auto status
/qwt auto on
/qwt auto off
/qwt import status
```

Automatic opening is enabled by default. Toggle **Open automatically on dungeon entry** or use `/qwt auto off` if you prefer to open `/qwt` manually. Opening the addon never applies talents until you click the import button.

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
   World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents/QuickWoWTalentsTalentCodec.lua
   World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents/QuickWoWTalentsTalentImport.lua
   World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents/Media/Logo.tga
   ```

4. Fully restart WoW for a new addon folder. For an update to an existing installation, run:

   ```text
   /reload
   ```

5. Run:

   ```text
   /qwt
   ```

## Updating

Install the newest zip from [Releases](https://github.com/QuickWoWTalents/quickwowtalents-addon/releases) over the existing `QuickWoWTalents` folder.

## Data source and privacy

- Source data comes from cached Quick WoW Talents recommendations.
- The generated addon data is bundled into `QuickWoWTalentsData.lua`.
- The addon is fully static/offline in-game.
- No in-game network calls are made.
- No player data is uploaded by the addon.
- Automatic Mythic+ opening only reads local WoW client context APIs such as current specialization, instance state, and current challenge map.

## Known limitations

- Import strings can become stale after Blizzard talent-tree or interface changes. Update to the latest release first if an import fails.
- Imports respect WoW's talent restrictions, including combat and active Mythic+ keystones. A changed build needs a spare saved-loadout slot so the previous build can be kept until the replacement succeeds.
- New loadouts use shared action bars; private action bar layouts are not copied into shared bars.
- Current bundled recommendations focus on Quick WoW Talents' supported public recommendation set.
- Automatic opening currently targets Mythic+ only. Raid recommendations remain available through the manual selector because exact boss context is not reliably known before pull.
- Automatic Mythic+ matching depends on the current season's client dungeon IDs. Unsupported or future dungeons simply fall back to manual `/qwt` behavior.

## Support

Please open an issue with:

- addon version
- WoW client version
- class/spec
- what `/qwt info` shows
- the import error or behavior you saw

## License

Copyright (c) 2026 Darragh. All rights reserved.
