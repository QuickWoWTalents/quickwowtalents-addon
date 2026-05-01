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

Keep the addon simple:

```text
QuickWoWTalents/
  QuickWoWTalents.toc
  QuickWoWTalents.lua
  QuickWoWTalentsData.lua
```

Optional soon:

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
