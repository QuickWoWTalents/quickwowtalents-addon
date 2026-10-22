# GitHub to CurseForge publication

The Mac produces and validates recommendation data. The existing GitHub workflow tests, packages, verifies, atomically pushes main and the release tag, and verifies the draft ZIP before publishing it. Those checks and the one-publication-per-Pacific-day gate remain unchanged.

After GitHub publication, `scripts/publish-curseforge.mjs` downloads the published GitHub ZIP and verifies its SHA-256, single-asset metadata, package version, remote tag, source ancestry and every packaged file against an isolated checkout of the tag. It sends those same bytes to CurseForge project 1530765. All supported Retail versions come from the tagged TOC and must match the official game-version catalog. Drafts, prereleases, wrong tags, wrong hashes and missing/ambiguous metadata fail closed.

## Single publishing path

The old CurseForge push webhook must stay inactive. An atomic main-and-tag push emits two GitHub push notifications. CurseForge's automatic packager can process both concurrently and publish the same tagged revision twice. Do not add a second uploader or re-enable that webhook alongside this workflow.

The replacement uses the documented [CurseForge Upload API](https://support.curseforge.com/support/solutions/articles/9000197321-curseforge-upload-api). The API does not document an idempotency key. Therefore the workflow records a durable reservation before its one upload request and never retries an uncertain request automatically.

The `curseforge-publications` branch is an orphan state branch, separate from addon source and release tags. Each `receipts/vX.Y.Z.json` contains the version, source commit, archive digest, project ID and a unique reservation. The GitHub Contents API creates this file without a prior SHA; an existing file or concurrent claim is an error, never permission to upload. Accepted uploads are recorded using the reservation's exact blob SHA and the returned CurseForge file ID. Do not delete receipts, reset this branch, or force-push it.

Versions through v1.0.155 were already handled by the old packager and are permanently excluded from upload. This includes the two existing copies of v1.0.155, which this change does not delete. A completed receipt makes later runs a no-op. A reserved receipt blocks later uploads even after a crash, HTTP error, or timeout. Changed source or archive bytes for the same version are rejected.

## Cutover

1. Test and review the replacement before changing the current handoff.
2. Confirm the latest old-packager version is still v1.0.155 and no publication or packaging job is active. If the latest version advanced, extend the migration floor and re-test before continuing.
3. Initialize `curseforge-publications` once with a public policy file documenting project 1530765 and the migration floor. Protect this state branch from deletion and force pushes.
4. Transfer the existing CurseForge credential securely into the repository Actions secret `QWT_CURSEFORGE_UPLOAD_TOKEN`. Never print the credential or the old webhook URL, which contains it.
5. Merge the tested workflow, deactivate the old push webhook, verify it is inactive, then set repository variable `QWT_CURSEFORGE_HANDOFF_ENABLED` to `true`. Keep the previous hook metadata in a private operational backup.
6. Run `npm run release:curseforge -- --check --tag v1.0.155` with the scoped credentials. This verifies the published asset and live game-version metadata without reserving or uploading anything. A normal invocation for this legacy tag must also make no upload.

Do not run a new release merely to test the cutover. The next authorized daily or manual release uses the replacement. Existing publication and artifact validations must stay enabled.

## Recovery

The CurseForge step is separate from the GitHub publisher. A downstream failure does not erase a successful GitHub publication or permit another automatic version that day. A later non-dry-run workflow can complete an unclaimed handoff for its current published version. Manual dry runs never invoke CurseForge.

For read-only verification of a published tag, run:

```sh
npm run release:curseforge -- --check --tag v1.0.156
```

If no reservation exists, fixing a preflight problem and running the existing-tag handoff is safe; it does not bump a version or alter the GitHub ZIP. If a reservation exists without a completed receipt, **do not delete it or upload again**. Inspect the original Actions output and CurseForge files/builds. An upload may have succeeded even when its response was lost. If a file is found, download it and verify its SHA-256 and contents against the recorded GitHub archive before completing the receipt with its exact file ID and prior blob SHA. If the outcome cannot be proved, leave the reservation blocking and escalate for operator reconciliation.

A `published` receipt records CurseForge's acceptance of the upload, not a guarantee that moderation has approved it. Keep the receipt if moderation is pending or rejects the file; uploading another copy is not recovery.
