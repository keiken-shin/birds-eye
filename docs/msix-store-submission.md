# Microsoft Store submission (MSIX)

## Why this exists

The Win32 `.exe` submission failed certification on **Store policy 10.2.9**: the uploaded
`birds-eye_x.y.z_x64-setup.exe` was **unsigned**, and Win32 installers must be code-signed
with a certificate that chains to the Microsoft Trusted Root Program. The Store does **not**
sign Win32 installers for you — you'd have to buy/rent a code-signing certificate.

MSIX avoids that entirely: **the Microsoft Store signs the MSIX for you on submission**, so
no certificate purchase is needed. That's the free path, and it's what this build produces.

> A Cloudflare/TLS SSL certificate can't be used here — it's a domain certificate for HTTPS,
> not a code-signing certificate.

## Build the MSIX

```powershell
scripts\build-msix.ps1              # unsigned .msix for Store upload
scripts\build-msix.ps1 -SkipBuild   # reuse existing release exe, just repackage
scripts\build-msix.ps1 -DevInstall  # self-sign + install locally to test it launches
```

Output: `src-tauri\target\msix-stage\<Name>_<version>_x64.msix`

Prereq (once): `winget install microsoft.winappcli --source winget`

## Partner Center steps (only you can do these)

MSIX and Win32 are different product **types** in Partner Center — you can't add an MSIX
package to the existing "EXE or MSI app". You create a new MSIX product, which needs the
"Birds Eye" name that the Win32 product currently holds.

1. **Free the name from the Win32 app.** Open the existing Win32 "Birds Eye" app →
   delete it (or remove its reserved name). This retires the failed Win32 submission.
2. **Create the MSIX app.** Apps and games → *New product* → **MSIX or PWA app** →
   reserve the name **Birds Eye**.
3. **Copy the identity values.** Open the new app → *Product management → Product identity*.
   Copy these three values:
   - `Package/Identity/Name`
   - `Package/Identity/Publisher`
   - `Package/Properties/PublisherDisplayName`
4. **Put them in the manifest.** Edit [`src-tauri/Package.appxmanifest`](../src-tauri/Package.appxmanifest):
   - `<Identity Name="...">` ← Package/Identity/Name
   - `<Identity Publisher="CN=...">` ← Package/Identity/Publisher (paste it verbatim)
   - `<PublisherDisplayName>...` ← Package/Properties/PublisherDisplayName
   Leave `Version` at a 4-part number whose last digit is `0` (e.g. `0.2.0.0`); the Store
   requires the revision to be 0.
5. **Rebuild and upload.** `scripts\build-msix.ps1` → upload the `.msix` in the new app's
   submission → **Packages** step. Submit. The Store signs it during certification.

## Notes

- Version must increase on each new upload (bump the 3rd digit: `0.2.1.0`, etc.).
- To ship Arm64 too, build an Arm64 exe and pack a second folder into a `.msixbundle`
  (`winapp package .\x64 .\arm64`). Skipped for now — x64 only.
- The package includes `priconfig.xml`/`pri.resfiles` (winapp build leftovers). Harmless —
  they don't affect certification.
