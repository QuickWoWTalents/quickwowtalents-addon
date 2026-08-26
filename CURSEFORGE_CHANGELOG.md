QuickWoWTalents 1.0.104 - 2026-08-26

- Updated bundled recommendation data from quickwowtalents.com.

- Added 12.1 / current-tier addon data download support for explicit no-log gaps while preserving strict cache-miss failures and validating only the actual skipped entries.
- Added Devourer Demon Hunter fallback spec ID support for generated addon data.
- Added all eight Midnight Season 2 dungeon mappings for automatic Mythic+ recommendations.
- Updated specialization detection to prefer the 12.1 namespaced API with legacy-client fallback.
- Added read-only pull request checks for tests, packaging, and release readiness.

Changes since v1.0.103
- Bind Mythic+ auto-open mapping assertions
- Bundle current WoW 12.1 recommendations
- Remove retired Mythic+ auto-open mappings
- Close addon release input boundaries
- Bound persisted release snapshot reads
- Gate addon releases on verified public WoW 12.1 data
- Harden 12.1 addon support
- Support current-tier addon data refresh
