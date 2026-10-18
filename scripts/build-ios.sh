#!/usr/bin/env bash
# Build, test or install the iPad app (ios/). Run from anywhere.
#
#   scripts/build-ios.sh build     the app for the simulator, unsigned (no Local.xcconfig needed)
#   scripts/build-ios.sh test      FremkitKit's tests, on the Mac
#   scripts/build-ios.sh install [launch arguments…]
#                                  a signed Debug build installed and launched on the iPad whose
#                                  UDID is in FREMKIT_IOS_DEVICE; signing comes from
#                                  ios/Local.xcconfig (copy ios/Local.example.xcconfig). Arguments
#                                  after `install` go to the app, e.g.
#                                  -FremkitSeedLink 'fremkit://pair?…' (Debug builds only).
#                                  The link carries the code's secret, which pairs past the
#                                  wrong-code limit: use a fresh one (it pairs once, for 5
#                                  minutes) and expect it in shell history.
#
# Build output goes to ios/build/ (git-ignored); the full log of the last xcodebuild run is
# ios/build/xcodebuild.log.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=ios/Fremkit.xcodeproj
SCHEME=Fremkit
DERIVED=ios/build
LOG="$DERIVED/xcodebuild.log"

die() { echo "build-ios: $*" >&2; exit 1; }

# xcodebuild needs Xcode (the iOS SDK), not the Command Line Tools. FREMKIT_XCODE points at
# another Xcode.app; an explicit DEVELOPER_DIR is left alone.
if [[ -z "${DEVELOPER_DIR:-}" && "$(xcode-select -p 2>/dev/null)" == *CommandLineTools* ]]; then
    xcode="${FREMKIT_XCODE:-/Applications/Xcode.app}"
    [[ -d "$xcode/Contents/Developer" ]] ||
        die "the active developer directory is the Command Line Tools and $xcode was not found: install Xcode (with the iOS platform) or set FREMKIT_XCODE=/path/to/Xcode.app"
    export DEVELOPER_DIR="$xcode/Contents/Developer"
fi

# Xcode's own line for an app without App Intents: not a diagnostic about this project.
NOISE='warning: Metadata extraction skipped, no AppIntents.framework dependency found'

# Runs xcodebuild quietly: the full log goes to $LOG, warnings and errors to the terminal.
xcb() {
    mkdir -p "$DERIVED"
    local status=0
    xcodebuild -project "$PROJECT" -scheme "$SCHEME" -derivedDataPath "$DERIVED" "$@" >"$LOG" 2>&1 || status=$?
    grep -E '(warning|error):' "$LOG" | grep -v -F "$NOISE" | uniq || true
    if [[ $status -ne 0 ]]; then
        tail -20 "$LOG" >&2
        die "xcodebuild failed ($status); full log: $LOG"
    fi
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    build)
        xcb -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
        echo "built: $DERIVED/Build/Products/Debug-iphonesimulator/Fremkit.app"
        ;;
    test)
        swift test --package-path ios/FremkitKit
        ;;
    install)
        [[ -f ios/Local.xcconfig ]] || die "ios/Local.xcconfig is missing: copy ios/Local.example.xcconfig and fill it in"
        device="${FREMKIT_IOS_DEVICE:-}"
        [[ -n "$device" ]] || die "set FREMKIT_IOS_DEVICE to the iPad's UDID (xcrun devicectl list devices)"
        xcb -configuration Debug -destination "id=$device" -allowProvisioningUpdates build
        app="$DERIVED/Build/Products/Debug-iphoneos/Fremkit.app"
        bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
        xcrun devicectl device install app --device "$device" "$app"
        # `--` ends devicectl's own options: without it, an argument for the app such as
        # -FremkitSeedLink is read as an unknown devicectl option and the launch fails.
        if [[ $# -gt 0 ]]; then
            xcrun devicectl device process launch --device "$device" --terminate-existing "$bundle_id" -- "$@"
        else
            xcrun devicectl device process launch --device "$device" --terminate-existing "$bundle_id"
        fi
        ;;
    *)
        die "usage: scripts/build-ios.sh build | test | install [launch arguments…]"
        ;;
esac
