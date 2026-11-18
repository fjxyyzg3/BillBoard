#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "$GITHUB_REPOSITORY_ID" != 1462445518 || "$GITHUB_REF" != refs/heads/master \
      || "$GITHUB_EVENT_NAME" != workflow_dispatch || "$(git rev-parse HEAD)" != "$GITHUB_SHA" ]]; then
  echo "The iOS archive must use the published master workflow source."
  exit 1
fi

work="$(mktemp -d "$RUNNER_TEMP/billboard-ios.XXXXXXXX")"
artifact="$RUNNER_TEMP/billboard-ios-artifact"
keychain="$work/signing.keychain-db"
system_profile=""
phase="signing configuration"
cleanup() {
  local result="$1"
  exec 1>&3 2>&4
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  if [[ -n "$system_profile" ]]; then rm -f -- "$system_profile" || true; fi
  rm -rf -- "$work" || true
  if (( result )) ; then
    echo "iOS release failed during $phase. Private build diagnostics were suppressed." >&2
  else
    echo "Verified the Ad Hoc signature and encrypted the iOS package."
  fi
  exit "$result"
}
# The private build log can contain profile details or the configured HTTPS origin.
exec 3>&1 4>&2
trap 'cleanup "$?"' EXIT
exec >"$work/build.log" 2>&1

export BILLBOARD_IOS_VERSION="$(node -p 'require("./package.json").version')"
export BILLBOARD_IOS_BUILD="$(node --input-type=module -e '
  import {iosBuildNumber} from "./src/lib/ios-release-manifest.mjs";
  process.stdout.write(iosBuildNumber(Number(process.env.GITHUB_RUN_NUMBER), Number(process.env.GITHUB_RUN_ATTEMPT)));')"
python3 ops/ios/signing.py prepare "$work"
security cms -D -i "$work/build.mobileprovision" >"$work/profile.plist"
profile_uuid="$(python3 ops/ios/signing.py profile "$work")"
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profiles"
system_profile="$profiles/$profile_uuid.mobileprovision"
install -m 600 "$work/build.mobileprovision" "$system_profile"

keychain_password="$(openssl rand -hex 32)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/distribution.p12" -P "$IOS_P12_PASSWORD" -k "$keychain" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"
security list-keychains -d user -s "$keychain"
certificate="$(security find-identity -v -p codesigning "$keychain" | awk '/"Apple Distribution:/ {print $2}')"
[[ "$certificate" =~ ^[A-F0-9]{40}$ ]]
export IOS_CERTIFICATE_ID="$certificate"
python3 ops/ios/signing.py export "$work"

phase="Xcode archive"
xcodebuild -project ios/BillBoard.xcodeproj -scheme BillBoard -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work/BillBoard.xcarchive" \
  "DEVELOPMENT_TEAM=$IOS_TEAM_ID" "PRODUCT_BUNDLE_IDENTIFIER=$IOS_BUNDLE_ID" \
  "MARKETING_VERSION=$BILLBOARD_IOS_VERSION" "CURRENT_PROJECT_VERSION=$BILLBOARD_IOS_BUILD" \
  "INFOPLIST_FILE=$work/Info.plist" CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=$certificate" \
  "PROVISIONING_PROFILE_SPECIFIER=$profile_uuid" archive

phase="Ad Hoc export and verification"
xcodebuild -exportArchive -archivePath "$work/BillBoard.xcarchive" \
  -exportPath "$work/export" -exportOptionsPlist "$work/ExportOptions.plist"
ipa="$work/export/BillBoard.ipa"
unzip -q "$ipa" -d "$work/extracted"
app="$work/extracted/Payload/BillBoard.app"
codesign --verify --deep --strict "$app"
codesign -d --entitlements :- "$app" >"$work/entitlements.plist"
codesign -d --extract-certificates="$work/actual-certificate-" "$app"
security cms -D -i "$app/embedded.mobileprovision" >"$work/embedded.plist"
python3 ops/ios/signing.py verify "$work"
node ops/ios/pack-release.mjs "$work/metadata.json" "$ipa" "$work/release.bin"

phase="artifact encryption"
archive="$work/age.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --max-time 60 \
  'https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-darwin-arm64.tar.gz' --output "$archive"
printf '%s  %s\n' e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5 "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$work" age/age
[[ "$IOS_AGE_RECIPIENT" =~ ^age1[a-z0-9]{58}$ ]]
mkdir -p "$artifact"
"$work/age/age" --recipient "$IOS_AGE_RECIPIENT" --output "$artifact/release.age" "$work/release.bin"
