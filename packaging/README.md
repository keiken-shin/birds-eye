# Packaging

Manifests so `winget install`, `scoop install` and `choco install` can find Bird's Eye. See
`birds-eye-positioning-2026-07-31.html` section 10, Week 3-4 ("Become findable") for why this
exists: package managers are how this category actually gets installed (WizTree alone has 2.58M
Chocolatey downloads).

```
packaging/
  winget/manifests/k/keiken-shin/BirdsEye/0.2.1/   # version / installer / defaultLocale YAML
  scoop/bucket/birds-eye.json                      # single manifest, autoupdate + checkver wired
  chocolatey/birds-eye.nuspec + tools/*.ps1         # nuspec + install/uninstall
  update-manifests.ps1                             # bumps all three to a new release
```

All three point at the same asset: the portable exe GitHub Releases attaches to every release
under the stable name `birds-eye-windows-portable-x64.exe` (see `docs/develop/releasing.md`).
winget and Chocolatey pin the **versioned** release URL
(`.../releases/download/v<version>/birds-eye-windows-portable-x64.exe`) so a manifest for an old
version keeps working after a new release ships. Scoop's `autoupdate.url` uses the same versioned
pattern with `$version` so `checkver -u` can re-derive it.

Every description/summary/tag field below is the research's approved copy, not new prose - see
the parent agent's report for the exact strings and where they came from.

## 1. Updating for a new release

The nuspec, the Scoop manifest and all three winget files currently carry a placeholder hash
(64 zeros, impossible to mistake for real) because a hash can't be computed for a binary that
hasn't been downloaded. Once a release is published:

```powershell
packaging\update-manifests.ps1 -Version 0.2.2
```

This downloads the real `v0.2.2` asset, computes its SHA256, rewrites the version + URL + hash
across all three manifest sets (creating a new dated folder for winget, editing Scoop/Chocolatey
in place), and then re-reads every file to confirm the rewrite actually took - it fails loudly
instead of silently if anything didn't match. Requires the GitHub release for that tag to already
exist with the `birds-eye-windows-portable-x64.exe` asset attached.

## 2. Submitting to winget

Repo: **https://github.com/microsoft/winget-pkgs**

1. Run the update script for the version you're shipping (above).
2. Optional local check first:
   ```powershell
   winget settings --enable LocalManifestFiles   # once, admin shell
   winget validate --manifest packaging\winget\manifests\k\keiken-shin\BirdsEye\0.2.1\
   winget install --manifest packaging\winget\manifests\k\keiken-shin\BirdsEye\0.2.1\
   ```
3. Fork `microsoft/winget-pkgs`, copy `packaging/winget/manifests/k/keiken-shin/BirdsEye/<version>/`
   into the fork at the identical path, commit, and open a PR. One version per PR - see
   [CONTRIBUTING.md](https://github.com/microsoft/winget-pkgs/blob/master/CONTRIBUTING.md).
   The automated pipeline re-downloads the installer and checks the hash, so a stale placeholder
   hash fails CI immediately (that's the point - it can't merge silently wrong).

## 3. Submitting to Scoop

Scoop has no central "submit here" queue - it's buckets (git repos of manifests) that users add
by URL.

- **Works today, no approval needed:** put `packaging/scoop/bucket/birds-eye.json` in its own
  repo (e.g. `keiken-shin/scoop-bucket`, with the manifest under a `bucket/` folder - that's the
  layout Scoop's bucket auto-detection expects) and tell users:
  ```powershell
  scoop bucket add birds-eye https://github.com/keiken-shin/scoop-bucket
  scoop install birds-eye
  ```
- **Official bucket:** Bird's Eye is a GUI app, so **Extras** is the fit, not Main (Main skews
  CLI tools) - **https://github.com/ScoopInstaller/Extras**. Open a PR adding
  `bucket/birds-eye.json` once the self-hosted bucket has proven the manifest works; read their
  contributing notes first.
- Test a manifest file directly before either path: `scoop install packaging\scoop\bucket\birds-eye.json`.

## 4. Submitting to Chocolatey

Community feed: **https://community.chocolatey.org/**

1. Create an account there, then get an API key from **https://community.chocolatey.org/account**
   (My Account -> API Keys) and save it once: `choco apikey --key <key> --source https://push.chocolatey.org/`.
2. Run the update script for the version you're shipping (above).
3. Build and test locally:
   ```powershell
   choco pack packaging\chocolatey\birds-eye.nuspec
   choco install birds-eye -s . -y      # from the folder holding the .nupkg
   ```
4. Push: `choco push birds-eye.0.2.1.nupkg --source https://push.chocolatey.org/`.
   New packages go through Chocolatey's automated + moderator review before they're listed -
   expect that to take a few days on the first submission.

`birds-eye` was unclaimed on the community feed as of 2026-07-31 (checked via the public OData
`Packages()` endpoint) - re-check before pushing in case that's changed.

## 5. Directory listings

Same rung of the plan (Week 3-4): these sites are where "best disk space analyzer" listicles
source from. **Every listing must use the identical one-liner** - see the parent report for the
exact text (research section 06, the GitHub About field copy). Don't let any of these drift from
each other or from the GitHub About field.

- [ ] **AlternativeTo** - https://alternativeto.net/manage/new/ (sign in, "Add new application";
      needs name, tagline, description, URL, category, logo, screenshot(s)).
- [ ] **Softpedia** - https://www.softpedia.com/user/submit.shtml (search first to confirm it
      isn't already listed; full form or a PAD file).
- [ ] **MajorGeeks** - no self-serve form; email `mgnews@majorgeeks.com` per
      https://www.majorgeeks.com/content/page/aboutcontact_us.html.
- [ ] **FossHub** - https://www.fosshub.com/signup.html (publisher sign-up; FossHub hosts the
      binary too, so decide whether that's a second distribution point or just a listing).

## What's unverified / assumed

- **winget schema**: fetched live from `microsoft/winget-pkgs` (`doc/manifest/schema/1.12.0/*.md`)
  on 2026-07-31 - `ManifestVersion: 1.12.0` is confirmed current as of that date, not from memory.
  Re-check `doc/manifest/schema/` for a newer folder before submitting if time has passed.
- **`birds-eye` as the id/moniker/bucket name**: confirmed free on the Chocolatey feed, in
  `ScoopInstaller/Main`, and at the winget `manifests/k/keiken-shin/BirdsEye` path as of
  2026-07-31. Re-check if this sits unsubmitted for a while.
- **Chocolatey package id has no `.portable` suffix**: that suffix convention exists to
  disambiguate an installer flavor from a portable flavor of the *same* package. Bird's Eye only
  ships portable, so there's nothing to disambiguate against - plain `birds-eye` matches how
  other portable-only tools are packaged.
- **Winget `Description` / Chocolatey `<description>`** open with the Store short-description
  sentence before the section 06② body, since winget has no separate slot for it the way the
  Store UI does. Flagged in the parent report for the research owner to confirm.
- **winget `ShortDescription` is a trimmed prefix of the section 06④ one-liner** (245 of 285
  chars, cut at a full sentence), because winget's schema hard-caps `ShortDescription` at 256
  characters and 06④ alone is 285. Scoop's `description` and Chocolatey's `<summary>` use the
  full 06④ text - only winget's is shortened, and only because the schema forces it.
