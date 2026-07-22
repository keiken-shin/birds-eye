#!/usr/bin/env bash
#
# Build the macOS app bundle + DMG for Bird's Eye.
#
# The build is UNSIGNED (no Apple Developer certificate required). On another
# machine, Gatekeeper needs the standard first-launch bypass: right-click the
# app > Open, or `xattr -dr com.apple.quarantine "Birds Eye.app"`.
#
# Usage:
#   scripts/build-macos.sh               # frontend + release build + .app + .dmg
#   scripts/build-macos.sh --skip-build  # reuse existing bundle, just rename/report
#
# Prereqs: Node + Rust toolchain and Xcode Command Line Tools.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_dir="$root/src-tauri/target/release/bundle"
arch="$(uname -m)"   # arm64 (Apple silicon) or x86_64 (Intel)

if [[ "${1:-}" != "--skip-build" ]]; then
  # tauri's beforeBuildCommand builds the frontend first; targets:"all" bundles
  # the .app and the .dmg.
  (cd "$root/workspace" && npm run tauri:build)
fi

app="$bundle_dir/macos/Birds Eye.app"
[[ -d "$app" ]] || { echo "No app bundle at $app — run without --skip-build first." >&2; exit 1; }

# Name the DMG after the release-artifact convention (birds-eye-windows-portable-x64.exe).
dmg_src="$(ls "$bundle_dir"/dmg/*.dmg 2>/dev/null | head -1 || true)"
[[ -n "$dmg_src" ]] || { echo "No DMG produced in $bundle_dir/dmg." >&2; exit 1; }
dmg_out="$bundle_dir/dmg/birds-eye-macos-$arch.dmg"
[[ "$dmg_src" == "$dmg_out" ]] || mv "$dmg_src" "$dmg_out"

echo
echo "App bundle: $app"
echo "DMG:        $dmg_out"
echo
echo "Unsigned build — first launch on another machine: right-click > Open."
