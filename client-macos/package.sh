#!/usr/bin/env bash
# Builds a Release app, signs it ad hoc (no Developer ID yet) and packs it into
# .build/VaultSyncryption-<version>.dmg with an /Applications link. Prints the DMG path.
set -euo pipefail
cd "$(dirname "$0")"

version=$(sed -n 's/^ *MARKETING_VERSION: *"\(.*\)"/\1/p' project.yml)
xcodegen --quiet
xcodebuild -project VaultSyncryption.xcodeproj -scheme VaultSyncryption \
  -destination 'generic/platform=macOS' -configuration Release \
  -derivedDataPath .build/xcode-release build >/dev/null

app=.build/xcode-release/Build/Products/Release/VaultSyncryption.app
codesign --force --deep --options runtime --sign - "$app" >&2
codesign --verify --strict "$app" >&2

stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
dmg=.build/VaultSyncryption-${version}.dmg
rm -f "$dmg"
hdiutil create -quiet -volname "Vault Syncryption ${version}" -srcfolder "$stage" \
  -format UDZO "$dmg"
rm -rf "$stage"
echo "$dmg"
