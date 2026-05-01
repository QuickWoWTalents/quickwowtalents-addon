# Releasing Quick WoW Talents Addon

The addon release process is automated through GitHub Actions.

## Schedule

`.github/workflows/daily-release.yml` runs daily at **15:30 UTC**.

That timing is intentional: the addon release downloads the product-side `QuickWoWTalentsData.lua` artifact from `quickwowtalents.com`, so releases should happen after the public cache has warmed.

## Normal automated release

On a scheduled run, the workflow:

1. bumps the patch version in `package.json` and `QuickWoWTalents/QuickWoWTalents.toc`
2. downloads the product-side addon data artifact
3. validates scripts and tests
4. packages `dist/QuickWoWTalents-<version>.zip`
5. commits the generated data/version bump to `main`
6. tags `v<version>`
7. creates a GitHub release with the zip asset

The workflow uses the built-in `GITHUB_TOKEN`; no repository secrets are required.

## Manual dry-run

Use **Actions → Daily addon release → Run workflow** and leave `dry_run=true`.

Dry-runs generate a limited one-spec data file into `/tmp`, run checks, and package locally. They do **not** commit, tag, or publish a release.

## Manual full release

Use this only when intentionally publishing outside the normal schedule:

1. Open **Actions → Daily addon release → Run workflow**.
2. Set `dry_run=false`.
3. Optional: set an explicit semver `version`, such as `0.2.11`.
4. Start the workflow.

## Failure handling

### Product artifact unavailable

If `https://quickwowtalents.com/api/addon-data` returns an error, do not force a release. The endpoint is cache-only by design; a failure usually means the public cache is incomplete or stale.

Fix the product/cache issue first, then rerun a manual dry-run before publishing.

### Tag already exists

The workflow refuses to overwrite existing tags. Use a new version or delete the failed release/tag only if you are certain the tag was never validly published.

### Release asset missing

If a release was created without an asset, rerun packaging locally and attach the matching zip to the existing release only if the tag points at the correct commit.

## Local verification

```bash
npm test
npm run build:data:download
npm run package
unzip -l dist/QuickWoWTalents-*.zip | head -50
```

The zip should contain a top-level `QuickWoWTalents/` folder with the `.toc`, addon Lua, and bundled data Lua files.
