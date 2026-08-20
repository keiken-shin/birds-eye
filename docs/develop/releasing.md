# Releasing

How Bird's Eye ships. It's published on the **Microsoft Store** (one-click, auto-updating)
and as a **portable `.exe`** on **GitHub Releases**. This page is for maintainers.

## Channels

- **Microsoft Store** — [live](https://apps.microsoft.com/detail/9NZH5J31GHSL). One-click
  install, automatic updates, and a Store-signed MSIX package. The build and submission flow
  is below.
- **GitHub Releases** — the portable download. The site and README link directly to the
  installer via a **stable, version-less asset name**, so the button always fetches the
  newest build without any docs edits.

!!! important "Attach a stable-named asset to every release"
    The download buttons point at
    `…/releases/latest/download/**birds-eye-windows-portable-x64.exe**`. GitHub's `latest/download/`
    redirect only works if an asset with that **exact** name exists on the latest release.
    So each release (including the current `v0.2.0`) must include an asset named
    **`birds-eye-windows-portable-x64.exe`** — the version stays in the release *tag*, not the
    filename. Either rename the built `.exe` to that on upload, or add a copy alongside the
    version-named one. Miss it and the direct link 404s.

## Why MSIX for the Store

The Win32 `.exe` route failed certification on **Store policy 10.2.9**: Win32 installers
must be code-signed with a certificate that chains to the Microsoft Trusted Root Program,
and the Store does **not** sign Win32 installers for you — you'd have to buy or rent a
code-signing certificate.

MSIX sidesteps that entirely: **the Microsoft Store signs the MSIX for you on submission.**
That's the free path, and it's what the build below produces.

!!! note
    A Cloudflare/TLS certificate can't be used here — that's a domain certificate for
    HTTPS, not a code-signing certificate.

## Build the MSIX

Prerequisite (once):

```powershell
winget install microsoft.winappcli --source winget
```

Then:

```powershell
scripts\build-msix.ps1              # unsigned .msix for Store upload
scripts\build-msix.ps1 -SkipBuild   # reuse an existing release exe, just repackage
scripts\build-msix.ps1 -DevInstall  # self-sign + install locally to test it launches
```

Output: `src-tauri\target\msix-stage\<Name>_<version>_x64.msix`

## Partner Center submission

MSIX and Win32 are different **product types** in Partner Center — you can't attach an
MSIX to an existing "EXE or MSI app," so the Store listing is a new MSIX product that needs
the reserved **Birds Eye** name.

1. **Free the name.** Delete (or unreserve the name from) the old Win32 "Birds Eye" app.
2. **Create the MSIX app.** *Apps and games → New product → MSIX or PWA app* → reserve
   **Birds Eye**.
3. **Copy the identity values** from *Product management → Product identity*:
   `Package/Identity/Name`, `Package/Identity/Publisher`, and
   `Package/Properties/PublisherDisplayName`.
4. **Put them in the manifest** — [`src-tauri/Package.appxmanifest`](https://github.com/keiken-shin/birds-eye/blob/main/src-tauri/Package.appxmanifest):
    - `<Identity Name="...">` ← Package/Identity/Name
    - `<Identity Publisher="CN=...">` ← Package/Identity/Publisher (verbatim)
    - `<PublisherDisplayName>...` ← Package/Properties/PublisherDisplayName
    - Keep `Version` a 4-part number whose last digit is `0` (e.g. `0.2.0.0`) — the Store
      requires the revision to be `0`.
5. **Rebuild and upload.** Run `scripts\build-msix.ps1`, upload the `.msix` in the new
   app's submission → **Packages** step, and submit. The Store signs it during
   certification.

## Versioning notes

- The version must **increase** on each upload — bump the third digit: `0.2.1.0`, and so on.
- **Arm64:** build an Arm64 exe and pack a second folder into a `.msixbundle`
  (`winapp package .\x64 .\arm64`). Currently x64 only.
- The winapp build leaves `priconfig.xml` / `pri.resfiles` in the stage — harmless, they
  don't affect certification.

## Store and listing copy

Every user-facing string that lives outside the app — the Store short and long descriptions,
the GitHub About field, the one-liner — is kept in [Store and listing copy](store-listing.md).
Copy from there rather than rewriting; those strings are the positioning, and they should stay
identical across every surface.

## Regenerating the demo

The demo on the README and docs landing page is `docs/assets/demo.gif`. Overwrite that one
file to refresh it everywhere. The full recipe — resolutions and export settings — is in
[`scripts/record-demo.md`](https://github.com/keiken-shin/birds-eye/blob/main/scripts/record-demo.md).
Record at a real 16:9 resolution so it isn't squashed.

The demo is **one story, not a feature tour**: Overview → a recommendation with its reason →
Stage selected → a grouped decision in Staged → Review. It stops before confirmation, so the
capture never performs a destructive action. The recommendation frame must stay legible after
GIF quantization; the size, age, and reason are the proof.

## Updating this documentation site

The pages you're reading are the markdown files in `docs/`. A small generator in `docs-site/`
reads them, renders them into `site/`, and `.github/workflows/docs.yml` publishes that to
GitHub Pages on every push to `main`. To preview locally:

```powershell
cd docs-site
npm install
npm run serve           # builds site/, then serves it on http://localhost:8000
```
