# QuickWoWTalents Changelog

## Unreleased

## 1.0.53 - 2026-06-25

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.52 - 2026-06-24

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.51 - 2026-06-23

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.50 - 2026-06-22

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.49 - 2026-06-21

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.48 - 2026-06-20

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.47 - 2026-06-19

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.46 - 2026-06-18

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.45 - 2026-06-17

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.44 - 2026-06-17

- Updated bundled recommendation data from quickwowtalents.com.

- Updated bundled raid recommendations for Rotmire and retained Voidspire Heroic coverage.

### Changes since v1.0.43
- Add Rotmire raid release note
- Retry temporary addon data artifact misses

## 1.0.43 - 2026-06-15

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.42 - 2026-06-14

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.41 - 2026-06-13

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.40 - 2026-06-12

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.39 - 2026-06-11

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.38 - 2026-06-10

- Updated bundled recommendation data from quickwowtalents.com.

- Advertise WoW 12.0.7 support in addon release metadata.

### Changes since v1.0.37
- Advertise WoW 12.0.7 addon support

## 1.0.37 - 2026-06-09

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.36 - 2026-06-08

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.35 - 2026-06-07

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.34 - 2026-06-06

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.33 - 2026-06-05

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.32 - 2026-06-04

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.31 - 2026-06-03

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.30 - 2026-06-02

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.29 - 2026-06-01

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.28 - 2026-05-31

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.27 - 2026-05-30

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.26 - 2026-05-29

- Updated bundled recommendation data from quickwowtalents.com.

### Changes since v1.0.25
- Fix CurseForge changelog formatting
- chore: verify addon release readiness

## 1.0.25 - 2026-05-28

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.24 - 2026-05-27

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.23 - 2026-05-26

- Updated bundled recommendation data from quickwowtalents.com.

### Changes since v1.0.22
- Add addon data completeness gate

## 1.0.22 - 2026-05-25

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.21 - 2026-05-24

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.20 - 2026-05-23

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.19 - 2026-05-22

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.18 - 2026-05-21

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.17 - 2026-05-20

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.16 - 2026-05-19

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.15 - 2026-05-18

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.14 - 2026-05-17

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.13 - 2026-05-16

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.12 - 2026-05-15

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.11 - 2026-05-14

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.10 - 2026-05-13

- Updated bundled recommendation data from quickwowtalents.com.

## 1.0.9 - 2026-05-08

- Updated bundled recommendation data from quickwowtalents.com.

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
