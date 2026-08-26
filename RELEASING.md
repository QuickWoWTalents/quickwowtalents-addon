# Releasing Quick WoW Talents Addon

The add-on release process is automated through GitHub Actions and fails closed unless the deployed production options, content-addressed catalog, and add-on artifact describe one exact snapshot.

## Schedule

`.github/workflows/daily-release.yml` checks for release-worthy data daily at **17:30 UTC** (`30 17 * * *`). This is after the production cache warm and monitor window.

A scheduled run publishes only when the validated recommendation data differs from the committed `QuickWoWTalentsData.lua`. A manual full release may continue when data is unchanged, but it runs every gate and cannot bypass validation. A manual dry-run also runs through packaging and release readiness, but never commits, tags, pushes, or creates a release.

## Production prerequisites

All of these conditions must hold before a release can publish:

- `https://quickwowtalents.com/api/options`, its advertised same-origin `/api/talent-catalog?sha256=<sha>` path, and `https://quickwowtalents.com/api/addon-data` are available from one production deployment.
- Options contain exact four-field `talentCatalogDownload` metadata; the catalog response is raw `application/gzip` with no content encoding, and its compressed bytes match the declared length and SHA-256.
- Production options, the parsed normalized catalog, and the add-on artifact report the same catalog source, live environment, WoW 12.1 build, interface `120100`, 40-spec count, and content hash.
- Options and the artifact report the same ordered Mythic+ and raid activity identities.
- The artifact is schema 3, its counts reconcile, all emitted strings decode against that exact catalog, and every omission uses an allowed safe skip code.
- A publishing run is on `refs/heads/main`, and the add-on checkout's captured base `HEAD` still equals a freshly queried remote `refs/heads/main` immediately before the workflow enables publication.
- The version/tag does not already exist.

The downloader persists the exact validated production options response, raw catalog gzip, and add-on data, then atomically renames a strict version-1 snapshot manifest last. The manifest records the SHA-256 and byte length of all three files. Source and ZIP readiness require that marker, re-hash the exact tuple, recheck the catalog download identity, and do not refetch. This makes deployment lag or an interrupted commit a hard failure.

Both workflows use Node.js 22 and `npm ci`. The pull-request workflow runs the same production acquisition, catalog/schema/source validation, tests, packaging, and readiness checks, but has read-only permissions and no publication steps.

## Gate order

For a release candidate, the workflow runs in this order:

1. Check out only the add-on repository without persisting its checkout credential.
2. Download production `/api/options`, the exact same-origin catalog gzip it advertises, and `/api/addon-data`; persist the validated tuple and atomically commit its snapshot manifest last.
3. Require and re-hash the snapshot manifest, revalidate the source file from those exact inputs, check script syntax, and run the full test suite.
4. Decide whether the run is a dry-run, scheduled no-change skip, or publishable release. Publication requires `refs/heads/main`, a captured base `HEAD` equal to both the current checkout and a fresh remote-main query, and scheduled comparison against committed `HEAD` so staged and unstaged changes are both visible.
5. Prepare the version/changelogs only for a publishable release and reject an existing tag.
6. Package `dist/QuickWoWTalents-<version>.zip`.
7. Re-hash the manifest-bound tuple, validate both source and ZIP data against the same options and catalog, and capture readiness `zipSha256`.
8. Only after all gates pass, create the local commit/tag. Immediately before publication, hash the final archive again and require it to equal readiness `zipSha256`; authenticate Git with the job token, atomically push fully qualified `main` and tag refspecs, then create the GitHub release with remote-tag verification enabled.

No commit, tag, push, or release occurs before source and archive readiness succeeds.

## Manual dry-run

Use **Actions → Daily addon release → Run workflow** and leave `dry_run=true`.

The dry-run obtains the full current production snapshots and catalog, then runs validation, syntax checks, tests, packaging, and source/ZIP readiness. It does not prepare a new version and cannot commit, tag, push, or publish. Because publication is unreachable, a dry-run may be launched from a non-`main` ref.

## Manual full release

Use a manual full release after an add-on code-only change or when intentionally publishing outside the recurring schedule. Follow this order:

1. Deploy the production endpoints that produce schema-3 data.
2. Complete production warming and monitoring; confirm `/api/options`, its `talentCatalogDownload` endpoint, and `/api/addon-data` describe the same deployed catalog.
3. Let the add-on pull-request workflow pass its production snapshot/catalog/package/readiness checks, then merge the add-on change.
4. Select the merged `main` branch in **Actions → Daily addon release → Run workflow**. A non-dry manual run from any other branch or tag fails before version preparation.
5. Set `dry_run=false`. Optionally provide a new plain-semver `version`; otherwise the workflow chooses the next patch.
6. Confirm the acquisition, validation, test, version, tag-protection, package, source/ZIP readiness, and final digest gates all pass.
7. Verify the pushed tag and GitHub release reference the expected commit and that the attached ZIP is the verified archive.

A manual full release may publish when recommendation data is unchanged, but it cannot bypass any schema, catalog, source, package, readiness, tag, or digest gate.

## Failure handling

### Product inputs unavailable or mismatched

Do not force a release. Fix the deployment/cache issue first, wait for production options, raw catalog gzip, and artifact to agree, then rerun a manual dry-run. A deployment lag is expected to fail before version preparation.

### Tag already exists

The workflow checks both local and remote tags and refuses to overwrite one. The final push updates `refs/heads/main` and the fully qualified tag ref atomically, and release creation uses `--verify-tag` rather than recreating a missing tag. Use a new version. Delete a failed release/tag only when you have independently established that it was never validly published.

### Checkout is not current remote main

Do not publish from a branch, tag, or stale `main` checkout. Rerun the workflow on the current `main` ref after the prior run or merge finishes. Non-main dry-runs remain available for validation because their publish output is permanently false.

### Archive digest changed

Do not upload the archive. Re-run packaging and readiness from the same persisted options/catalog inputs. Publication deliberately fails if the final ZIP differs by even one byte from the archive inspected by readiness.

### Release asset missing

If a push succeeds but GitHub release creation fails, attach an archive only after rerunning readiness for the exact tagged source and independently confirming its SHA-256 digest.

## Local release-equivalent verification

Use absolute paths for the persisted production inputs:

```bash
OPTIONS_PATH=/tmp/quickwowtalents-release-options.json
CATALOG_PATH=/tmp/quickwowtalents-release-catalog.json.gz
MANIFEST_PATH=/tmp/quickwowtalents-release-snapshot-manifest.json

npm ci
npm run build:data:download -- \
  --url https://quickwowtalents.com/api/addon-data \
  --options-url https://quickwowtalents.com/api/options \
  --options-output "$OPTIONS_PATH" \
  --catalog-output "$CATALOG_PATH" \
  --snapshot-manifest-output "$MANIFEST_PATH"
npm run validate:data -- \
  --addon "$PWD/QuickWoWTalentsData.lua" \
  --options "$OPTIONS_PATH" \
  --catalog "$CATALOG_PATH" \
  --snapshot-manifest "$MANIFEST_PATH" \
  --require-catalog-download
npm test
npm run package
npm run release:verify -- \
  --options "$OPTIONS_PATH" \
  --catalog "$CATALOG_PATH" \
  --snapshot-manifest "$MANIFEST_PATH" \
  --require-catalog-download
```

`release:verify` prints the verified archive path and `zipSha256`. The source files intentionally remain at repository root for CurseForge automatic packaging compatibility; the ZIP must contain only the top-level `QuickWoWTalents/` folder and its three expected files.
