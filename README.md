# Quick WoW Talents Addon

Personal/manual World of Warcraft addon for Quick WoW Talents.

## Goal

Keep this intentionally basic:

- no Warcraft Logs calls from inside WoW
- no live Quick WoW Talents calls from inside WoW
- bundled data only
- manual install/share while the idea is validated

## What the MVP does

Run:

```text
/qwt
```

The addon detects your current specialization and opens a small selector with:

- mode dropdown: **Mythic+** or **Heroic Raid**
- encounter dropdown:
  - Mythic+: dungeon selector, **Best Overall** only
  - Raid: boss selector, **Heroic** only
- copyable Blizzard talent import string

The addon only chooses between bundled strings. It does not call any external API from inside WoW.

Extra commands:

```text
/qwt info
/qwt hide
```

## Local install

Copy the `QuickWoWTalents/` folder into:

```text
World of Warcraft/_retail_/Interface/AddOns/QuickWoWTalents
```

Then reload WoW:

```text
/reload
```

Run:

```text
/qwt
```

## Build bundled data

```bash
npm run build:data
```

This fetches cached public QWT build payloads and writes:

```text
QuickWoWTalents/QuickWoWTalentsData.lua
```

By default it exports every current spec for every current Mythic+ dungeon plus every current raid boss on Heroic. Use a slower delay if needed to stay comfortably under public rate limits:

```bash
node scripts/build-data.mjs --delay-ms 1500
```

Quick small test export for one spec:

```bash
node scripts/build-data.mjs --spec "Warlock:Demonology" --delay-ms 1200
```

## Package zip

```bash
npm run package
```

Creates:

```text
dist/QuickWoWTalents-0.2.0.zip
```
