# QuickWoWTalents Changelog

## Unreleased

## 1.0.8 - 2026-05-07

- Updated bundled recommendation data from quickwowtalents.com.

- Added Mythic+ auto-open support when entering a supported dungeon with a bundled build for the current specialization.
- Added `/qwt auto status`, `/qwt auto on`, and `/qwt auto off` controls.
- Auto-open is throttled to once per instance/spec/dungeon context, waits briefly after zoning for client APIs to settle, and defers while in combat.

### Changes since v1.0.7
- Improve addon release changelog notes
- Add Mythic+ auto-open support

## 1.0.0

First public QuickWoWTalents addon release.

- Bundles static/offline Quick WoW Talents import strings.
- Supports `/qwt`, `/qwt info`, and `/qwt hide`.
- Includes Mythic+ and Heroic Raid recommendation selectors.
- No in-game network calls; data is generated outside WoW from quickwowtalents.com.

## Versioning

- Patch releases update bundled recommendation data only when data actually changes.
- Minor releases are backward-compatible addon/code improvements.
- Major releases are reserved for major refreshes or incompatible changes.
