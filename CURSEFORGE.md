# CurseForge Publishing

Project page:

```text
https://legacy.curseforge.com/wow/addons/quickwowtalents
```

## Automatic packaging

CurseForge automatic packaging is driven by a GitHub repository webhook. The repository intentionally keeps the addon `.toc`, addon Lua, and bundled data Lua at the repository root, matching established addon repos like RaiderIO and SimulationCraft. The `.pkgmeta` `package-as: QuickWoWTalents` setting tells CurseForge to package those root addon files into a final `QuickWoWTalents/` addon folder while ignoring development files.

## Webhook setup

1. Create a CurseForge API token at:

   ```text
   https://www.curseforge.com/account/api-tokens
   ```

2. Find the CurseForge project ID in the project's **About This Project** section.

3. In GitHub, open:

   ```text
   https://github.com/QuickWoWTalents/quickwowtalents-addon/settings/hooks
   ```

4. Add a webhook:

   ```text
   https://www.curseforge.com/api/projects/{projectID}/package?token={token}
   ```

5. Leave the default event as **Just the push event**.

## Release behavior

- Tags like `v1.0.0` are packaged as release files.
- Tags containing `alpha` are packaged as alpha files.
- Tags containing `beta` are packaged as beta files.
- The daily GitHub workflow only pushes a new tag when bundled recommendation data actually changes.

## Required GitHub Actions org setting

The org must allow workflow write permissions so the daily release workflow can commit, tag, and create GitHub releases:

```text
QuickWoWTalents org → Settings → Actions → General → Workflow permissions → Read and write permissions
```
