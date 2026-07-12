# Releasing

How Bird's Eye ships. Today the primary channel is **GitHub Releases**; a **Microsoft
Store** listing is in progress. This page is for maintainers.

## Channels

- **GitHub Releases** — the current, canonical download. Users get it from
  [`/releases/latest`](https://github.com/keiken-shin/birds-eye/releases/latest).
- **Microsoft Store** — coming soon. One-click install and automatic updates, shipped as
  an MSIX package. The build and submission flow is below.

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

## Regenerating the demo

The demo on the README and docs landing page is `docs/assets/demo.gif`. Overwrite that one
file to refresh it everywhere. The full recipe — resolutions, the seven-view walkthrough,
and export settings — is in
[`scripts/record-demo.md`](https://github.com/keiken-shin/birds-eye/blob/main/scripts/record-demo.md).
Record at a real 16:9 resolution so it isn't squashed.

## Updating this documentation site

The docs are built with MkDocs Material and deployed to GitHub Pages by
`.github/workflows/docs.yml` on every push to `main`. To preview locally:

```powershell
pip install mkdocs-material
mkdocs serve            # http://127.0.0.1:8000
```
