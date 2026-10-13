#!/bin/zsh
# Builds "B-Side.app" from src/ and installs it to /Applications.
#   ./build.sh               build and install
#   ./build.sh --no-install  build into build/ only
#   ./build.sh --release     build, then zip it into build/ with a SHA-256 for a GitHub release
# Needs only what ships with macOS: osacompile, PlistBuddy, qlmanage, sips, iconutil, codesign.
set -e
cd "${0:A:h}"
VERSION="1.0"
APP="build/B-Side.app"
PLIST="$APP/Contents/Info.plist"
rm -rf build && mkdir -p build

osacompile -l JavaScript -s -o "$APP" src/engine.js
cp src/panel.html "$APP/Contents/Resources/"

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" 2>/dev/null || true; }
pb "Delete :LSUIElement"
pb "Set :CFBundleIdentifier com.feldberg.bside" ; pb "Add :CFBundleIdentifier string com.feldberg.bside"
pb "Delete :CFBundleDisplayName";      pb "Add :CFBundleDisplayName string B-Side"
pb "Delete :CFBundleShortVersionString"; pb "Add :CFBundleShortVersionString string $VERSION"
pb "Delete :NSAppleEventsUsageDescription"
pb "Add :NSAppleEventsUsageDescription string B-Side takes the YouTube video playing in Chrome and hands it back when you turn the wallpaper off."

# Icon: render the SVG with Quick Look, then build an .icns.
TMP=$(mktemp -d)
qlmanage -t -s 1024 -o "$TMP" src/icon.svg >/dev/null 2>&1
if [[ -f "$TMP/icon.svg.png" ]]; then
  mkdir "$TMP/icon.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.svg.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"
  pb "Delete :CFBundleIconName"
  pb "Set :CFBundleIconFile applet"
fi
rm -rf "$TMP"

# Ad-hoc signature with an identifier-only requirement, so macOS keeps the Chrome permission across rebuilds.
codesign --force --deep -s - -r='designated => identifier "com.feldberg.bside"' "$APP" >/dev/null 2>&1
if [[ "$1" == "--release" ]]; then
  ZIP="build/B-Side-$VERSION.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  shasum -a 256 "$ZIP" | tee "$ZIP.sha256"
  exit 0
fi

if [[ "$1" != "--no-install" ]]; then
  osascript -e 'quit app "B-Side"' >/dev/null 2>&1 || true
  pkill -f "B-Side.app/Contents/MacOS" 2>/dev/null || true
  rm -rf "/Applications/B-Side.app"
  cp -R "$APP" /Applications/
  touch "/Applications/B-Side.app"
  rm -rf "$APP"   # no second copy left in build/ for Spotlight to open
  echo "Installed /Applications/B-Side.app"
fi
