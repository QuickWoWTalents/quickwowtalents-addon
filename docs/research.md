# Quick WoW Talents Addon Research

Date: 2026-04-26

## Decision

Initial v0 decision: build this as a personal/manual addon first:

- no network calls from the addon
- Quick WoW Talents website/cache remains the source of truth
- addon ships with bundled generated Lua data
- `/qwt` shows the best matching import string and makes it easy to copy/import manually
- distribution/update automation can wait

Current status: distribution/update automation now exists through GitHub Actions and daily GitHub releases. The core product decision remains unchanged: keep the addon static/offline in-game and focused on “find build, copy string,” not a noisy in-game dashboard.

## Sources checked

- Blizzard UI source mirror: https://github.com/Gethe/wow-ui-source
- Class talent import/export implementation: https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_PlayerSpells/ClassTalents/Blizzard_ClassTalentImportExport.lua
- Generated Class Talents API docs: https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/ClassTalentsDocumentation.lua
- Generated Specialization API docs: https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/SpecializationInfoDocumentation.lua
- Generated Challenge Mode API docs: https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/ChallengeModeInfoDocumentation.lua
- Blizzard UI Add-On Development Policy: https://us.forums.blizzard.com/en/wow/t/ui-add-on-development-policy/24534

## Relevant Blizzard APIs

### Current spec detection

Use:

- `GetSpecialization()`
- `GetSpecializationInfo(index)`

Blizzard's generated docs show `GetSpecializationInfo` returns `specId`, `name`, `description`, `icon`, `role`, etc. This is enough to identify the current class/spec and map into our generated data.

### Mythic+ context detection

Useful APIs:

- `C_ChallengeMode.GetActiveChallengeMapID()`
- `C_ChallengeMode.GetActiveKeystoneInfo()`
- `C_ChallengeMode.GetSlottedKeystoneInfo()`
- `C_ChallengeMode.GetMapUIInfo(mapChallengeModeID)`
- `C_ChallengeMode.GetMapTable()`
- `GetInstanceInfo()`
- `GetDifficultyInfo(difficultyID)`

For v0, do not overfit to exact dungeon detection. Start with **Best Overall Mythic+** for current spec. Add dungeon-aware matching later once the data mapping is proven.

### Mythic+ auto-open prior art

The public auto-open implementation should follow established addon patterns rather than relying on one event or fragile name matching:

- BigWigs registers `PLAYER_ENTERING_WORLD` and uses `GetInstanceInfo()` / instance IDs to load zone-specific modules. It also has `PLAYER_MAP_CHANGED` handling and notes that `GetInstanceInfo()` may lag briefly after map changes.
  - https://github.com/BigWigsMods/BigWigs/blob/38bb1a374c257d33dc74addb5546c2482bdcb507/Loader.lua#L1166-L1176
  - https://github.com/BigWigsMods/BigWigs/blob/38bb1a374c257d33dc74addb5546c2482bdcb507/Loader.lua#L1934-L1980
  - https://github.com/BigWigsMods/BigWigs/blob/38bb1a374c257d33dc74addb5546c2482bdcb507/Loader.lua#L2004-L2013
- DBM registers load, zone, specialization, map, and challenge-mode events, then performs delayed secondary checks because instance data can be stale right after transitions.
  - https://github.com/DeadlyBossMods/DeadlyBossMods/blob/eb8b7d59a734709c1ce0e74ba66755cd86104695/DBM-Core/DBM-Core.lua#L2088-L2147
  - https://github.com/DeadlyBossMods/DeadlyBossMods/blob/eb8b7d59a734709c1ce0e74ba66755cd86104695/DBM-Core/DBM-Core.lua#L4255-L4270
  - https://github.com/DeadlyBossMods/DeadlyBossMods/blob/eb8b7d59a734709c1ce0e74ba66755cd86104695/DBM-Core/DBM-Core.lua#L4370-L4379
- Raider.IO is the closest Mythic+ mapping reference: it checks `C_ChallengeMode.GetActiveChallengeMapID()`, falls back through `GetInstanceInfo()`, and translates client dungeon IDs through its bundled dungeon metadata.
  - https://github.com/RaiderIO/raiderio-addon/blob/f58d2177c3af79641b9dcbc416092b9b54c623fd/core.lua#L11135-L11171
  - https://github.com/RaiderIO/raiderio-addon/blob/f58d2177c3af79641b9dcbc416092b9b54c623fd/core.lua#L11276-L11294
  - https://github.com/RaiderIO/raiderio-addon/blob/f58d2177c3af79641b9dcbc416092b9b54c623fd/core.lua#L13721-L13724
- Mythic Dungeon Tools delays `PLAYER_ENTERING_WORLD` startup work with `C_Timer.After(1, ...)`, supporting the same post-zone-load settling delay.
  - https://github.com/Nnoggie/MythicDungeonTools/blob/22604b2473e79beba210dc7b4ac2ffb040c8c458/MythicDungeonTools.lua#L247-L323

QWT implementation constraints from those references:

- listen to zoning, specialization, and challenge-mode events
- wait briefly after zoning before resolving context
- map client challenge/instance IDs explicitly to bundled QWT dungeon IDs
- auto-open once per instance/spec/dungeon context
- never open while in combat; defer until combat ends
- provide `/qwt auto` controls so public users can disable the behavior

### Talent import strings

Blizzard's class talent import/export implementation confirms the current talent string format is Blizzard's own import/export string. Important details from the source:

- Header includes serialization version, specialization ID, and a 128-bit tree hash.
- `C_Traits.GetLoadoutSerializationVersion()` defines the current serialization version.
- Import fails if the string serialization version mismatches the client.
- Import fails if the string is for a different current spec.
- Third-party strings may zero-fill tree hash, but if the tree changes, import may be incomplete/incorrect.
- Blizzard's own import path eventually calls `C_ClassTalents.ImportLoadout(configID, entries, loadoutName, importText)`.

For v0, safest path is: **display/select the import string in an EditBox and let the user paste/import through Blizzard's normal UI**. Avoid trying to directly call `C_ClassTalents.ImportLoadout` until basic lookup is validated.

## Best v0 approach

### Addon files

Keep the addon simple. Source files live at the repository root so CurseForge automatic packaging can package them into the final `QuickWoWTalents/` addon folder:

```text
QuickWoWTalents.toc
QuickWoWTalents.lua
QuickWoWTalentsData.lua
```

Optional support files:

```text
scripts/
  build-data.mjs
  package-addon.mjs
```

### Data shape

Generate Lua, not JSON, for the in-game addon:

```lua
QuickWoWTalentsData = {
  schemaVersion = 1,
  generatedAt = "2026-04-26T00:00:00.000Z",
  source = "quickwowtalents.com",
  recommendations = {
    [266] = { -- Demonology Warlock spec ID
      mplusBestOverall = {
        metric = "dps",
        label = "Demonology Warlock — Mythic+ Best Overall",
        importString = "...",
        sampleCount = 123,
        snapshotDate = "2026-04-26"
      }
    }
  }
}
```

Use numeric spec IDs as the primary key. Names are useful display metadata but not stable enough as identifiers.

### UI behavior

V0 should support:

- `/qwt`
- detect current spec via `GetSpecialization()` / `GetSpecializationInfo()`
- find `recommendations[specId].mplusBestOverall`
- show a small frame with:
  - spec/build label
  - generated date/snapshot date
  - import string in an EditBox
  - “Select text” button
  - short instruction: copy this and import in the Blizzard talent UI

Do not implement talent tree rendering in-game. Do not implement stat dashboards.

## Potential issues

### 1. Addons cannot be live-data clients

The addon should not call Warcraft Logs, Quick WoW Talents, or any external API from inside WoW. Treat addon data as bundled/static. Updates happen by regenerating `QuickWoWTalentsData.lua` out of game.

### 2. Import strings can stale across patches

Blizzard's source explicitly ties import strings to `C_Traits.GetLoadoutSerializationVersion()` and the tree hash. Talent tree changes can make old strings fail or import incorrectly. We need data metadata in the addon:

- generated date
- QWT snapshot date
- game build/interface version if we can include it
- maybe QWT export schema version

### 3. Direct import may be fragile/taint-sensitive

Generated API docs mark several talent APIs with `SecretArguments = "AllowedWhenUntainted"`. Directly automating import may work from a clean click path, but it is higher risk than showing a copyable string. For v0, avoid direct import.

### 4. Combat lockdown / protected UI

Do not try to alter talents, loadouts, or protected UI in combat. Even showing a passive frame is fine; modifying talent config should be user-driven and out of combat.

### 5. Copy-to-clipboard is limited

Assume we cannot silently write to the OS clipboard. Use an EditBox with the import string, focus it, highlight text, and tell the user to copy.

### 6. Addon policy matters if shared publicly

Blizzard's add-on policy says add-ons must be free, code visible/not obfuscated, no in-game ads, no in-game donation solicitation, and must not negatively affect realms/players. For private/manual sharing this is low-risk, but we should build in that direction from the start.

### 7. Interface version drift

The `.toc` `## Interface` number will need updates each retail patch. For personal use, enabling “Load out of date AddOns” is a workaround, but we should update it when packaging.

### 8. Spec/dungeon ID mapping

QWT website uses WCL/static data IDs; WoW client APIs use spec IDs and Mythic+ challenge map IDs. We need an explicit mapping layer in the export. Best Overall per spec avoids dungeon mapping in v0.

## Recommended next implementation step

Add a branch in the main QWT repo to export a small Lua data file for **Mythic+ Best Overall by spec** from cached recommendations, then copy that file into this addon repo.

Then implement addon v0 UI around that bundled data.
