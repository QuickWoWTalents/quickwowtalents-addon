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

## Support

Please open an issue with:

- addon version
- WoW client version
- class/spec
- what `/qwt info` shows
- the import error or behavior you saw

## License

Copyright (c) 2026 Darragh. All rights reserved.
