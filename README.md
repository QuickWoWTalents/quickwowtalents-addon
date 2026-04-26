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

The addon detects your current specialization, looks up the bundled Quick WoW Talents recommendation for that spec, and shows a copyable Blizzard talent import string.

Current MVP data is **Mythic+ Best Overall for the default QWT dungeon**. The frame labels the dungeon explicitly so we do not pretend this is all-dungeon coverage yet.

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

Use a slower delay if needed:

```bash
node scripts/build-data.mjs --delay-ms 1500
```

## Package zip

```bash
npm run package
```

Creates:

```text
dist/QuickWoWTalents-0.1.0.zip
```
