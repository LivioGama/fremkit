#!/usr/bin/env bash
# Build the Fremkit helper binary with swiftc (no SwiftPM), then assemble the app bundle.
# Run from the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/swiftc-common.sh
source scripts/lib/swiftc-common.sh
# shellcheck source=lib/version.sh
source scripts/lib/version.sh
VERSION="$(fremkit_version)"

echo "SDK: $SDK"

mkdir -p "$OUT"
echo "==> FremkitCore"
fremkit_build_core "$OUT" -O

echo "==> FremkitHelper"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitHelper \
    native/Sources/FremkitHelper/*.swift \
    -I "$OUT" -L "$OUT" -lFremkitCore \
    -framework AppKit \
    -framework WebKit \
    -framework IOKit \
    -framework ServiceManagement \
    -o "$OUT/FremkitHelper"

echo "built: $OUT/FremkitHelper"

# The disk map's scanner: its own small executable, which the server runs like `du` (the helper
# tells it where through FREMKIT_SCANNER). It needs nothing but FremkitCore and Foundation.
echo "==> fremkit-scan"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitScan \
    native/Sources/FremkitScan/main.swift \
    -I "$OUT" -L "$OUT" -lFremkitCore \
    -o "$OUT/fremkit-scan"

# The media player's reader. Since macOS 15.4 `mediaremoted` refuses MediaRemote reads from
# software Apple has not signed ("Operation not permitted"), so the calls live in a library that
# `adapter.pl` loads into `/usr/bin/perl`, which is entitled. The executable named to the server
# by FREMKIT_NOWPLAYING is only a launcher for those two: all three must stay in the same folder.
echo "==> fremkit-nowplaying"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitNowPlaying \
    native/Sources/FremkitNowPlaying/main.swift \
    -o "$OUT/fremkit-nowplaying"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitMediaRemote -emit-library \
    native/Sources/FremkitNowPlaying/MediaRemote.swift \
    native/Sources/FremkitNowPlaying/Adapter.swift \
    -framework AppKit \
    -o "$OUT/libFremkitMediaRemote.dylib"
cp native/Sources/FremkitNowPlaying/adapter.pl "$OUT/fremkit-nowplaying.pl"

echo "==> app bundle"
APP="native/dist/Fremkit Helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/FremkitHelper" "$APP/Contents/MacOS/FremkitHelper"
cp "$OUT/fremkit-scan" "$APP/Contents/MacOS/fremkit-scan"
cp "$OUT/fremkit-nowplaying" "$APP/Contents/MacOS/fremkit-nowplaying"
cp "$OUT/fremkit-nowplaying.pl" "$APP/Contents/MacOS/fremkit-nowplaying.pl"
cp "$OUT/libFremkitMediaRemote.dylib" "$APP/Contents/MacOS/libFremkitMediaRemote.dylib"
cp native/Resources/Info.plist "$APP/Contents/Info.plist"
fremkit_stamp_version "$APP/Contents/Info.plist" "$VERSION"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Brand assets: the app icon named by CFBundleIconFile, and the menu bar glyph. The "Template"
# suffix in the file name is what makes AppKit tint the glyph for the current menu bar theme.
cp brand/icon/Fremkit.icns "$APP/Contents/Resources/Fremkit.icns"
cp brand/menubar/fremkitTemplate.png brand/menubar/fremkitTemplate@2x.png "$APP/Contents/Resources/"
# The permission prompts' text, in French and English (see Info.plist).
cp -R native/Resources/en.lproj native/Resources/fr.lproj "$APP/Contents/Resources/"

# Ad-hoc signatures change with every build, and TCC ties its Input Monitoring and
# Accessibility grants to the signature, so each rebuild forces the user to grant again.
# A stable identity avoids that: any code-signing certificate in the login keychain named
# FREMKIT_SIGN_IDENTITY (default "Fremkit Helper Dev", self-signed is fine) is used when present.
IDENTITY="${FREMKIT_SIGN_IDENTITY:-Fremkit Helper Dev}"
#
# `--options runtime` turns on the hardened runtime, which is what makes the bundle's TCC grants
# (Input Monitoring, Accessibility) belong to *this* signed code rather than to whatever happens
# to sit at the path. `--deep` is deprecated and signs nested code with the outer identity
# instead of its own. Each piece of nested code (fremkit-scan, fremkit-nowplaying and the library
# it loads) is signed on its own first, with its own identifier, and the bundle after it: inside
# out.
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo "signing with: $IDENTITY"
    SIGN_AS="$IDENTITY"
else
    echo "signing ad hoc (no \"$IDENTITY\" identity in the keychain; run scripts/create-signing-identity.sh)"
    SIGN_AS="-"
fi
codesign --force --options runtime --identifier dev.fremkit.scan --sign "$SIGN_AS" "$APP/Contents/MacOS/fremkit-scan"
codesign --force --options runtime --identifier dev.fremkit.nowplaying.library --sign "$SIGN_AS" "$APP/Contents/MacOS/libFremkitMediaRemote.dylib"
# The adapter is a script: codesign seals it as generic code, which is what lets the bundle pass
# --verify --strict at all. It is not executed directly — the launcher hands it to /usr/bin/perl.
chmod +x "$APP/Contents/MacOS/fremkit-nowplaying.pl"
codesign --force --identifier dev.fremkit.nowplaying.script --sign "$SIGN_AS" "$APP/Contents/MacOS/fremkit-nowplaying.pl"
codesign --force --options runtime --identifier dev.fremkit.nowplaying --sign "$SIGN_AS" "$APP/Contents/MacOS/fremkit-nowplaying"
codesign --force --options runtime --sign "$SIGN_AS" "$APP"
codesign --verify --strict "$APP"

# The bundle declares the `fremkit://` URL scheme, and LaunchServices registers every copy it
# notices — including this build folder. `open -b dev.fremkit.helper fremkit://admin` would then
# be free to launch *this* copy beside the installed one, leaving the Mac with two helpers
# fighting over the touch panel and the same server. The copy install-helper.sh puts in
# ~/Applications is the one LaunchServices should know, so the build folder unregisters itself.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true; fi

echo "bundle: $APP"
