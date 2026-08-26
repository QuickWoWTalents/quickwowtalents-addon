# WoW 12.1 Current-Only Addon Contract

**Status:** Approved for implementation

This document defines the release contract enforced by the add-on repository.

## Release contract

- Accept only product addon data with `schemaVersion = 3`, `clientInterface = 120100`, and a `talentCatalog` describing Raidbots `live`, WoW `12.1.x`, exactly 40 specs, and a non-empty content hash.
- Fetch `/api/options`, its advertised content-addressed normalized catalog, and `/api/addon-data` in the same generation run. `talentCatalogDownload` contains exactly `path`, `sha256`, `bytes`, and `mediaType`; accept only a same-origin HTTPS `/api/talent-catalog?sha256=<sha>` path and raw `application/gzip` bytes whose compressed length and SHA-256 match. Their catalog descriptor and ordered Mythic+ and raid activity identities must agree exactly.
- The bundled recommendation strings must decode structurally against the exact normalized talent catalog identified by the product descriptor. Removed or unknown talent IDs are fatal; no string may be partially accepted.
- Counts are `specs`, `attempted`, `emitted`, `specsWithAnyRecommendation`, and `skipped`; require `emitted + skipped === attempted`.
- Only `NO_USABLE_LOGS` and `NO_COMPATIBLE_CURRENT_LOGS` are safe omissions. Every other skip code is fatal.
- Runtime copy/apply behavior is enabled only when schema 3 is present and the running client interface equals `120100`. A mismatch shows an update-required message. Exact hotfix build numbers are not compared in game.
- Remove the old `mplusBestOverall` runtime fallback. Schema 3 uses encounter-specific `mplus.encounters` and `raid.encounters` entries.
- Release acquisition persists the exact validated options, catalog gzip, and add-on bytes, then writes a strict digest manifest last. Release readiness re-hashes that exact tuple, rechecks the raw catalog download binding, and validates the source data file and the copy packaged in the zip, including schema, interface, descriptor, activities, counts, safe skips, and structural import-string compatibility.
- The recurring GitHub release runs at `17:30 UTC`, after the product warm and monitor window. Validation, tests, packaging, and archive inspection all precede commit, tag, push, and GitHub release creation.
- The intended first release is `v1.0.104`; never overwrite an existing tag or asset.

## Failure behavior

Every contract mismatch fails closed before replacing `QuickWoWTalentsData.lua` or publishing a release. The options, catalog, add-on, and manifest outputs are staged only after all inputs validate; the manifest is committed last, so later gates reject any interrupted tuple. The existing committed file remains untouched after a failed download. A released addon remains an offline snapshot and never calls production endpoints from the game client.
