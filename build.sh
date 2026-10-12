#!/bin/zsh
# Builds "YouTube Wallpaper.app" from src/ and installs it to /Applications.
# Needs only what ships with macOS: osacompile, PlistBuddy, qlmanage, sips, iconutil, codesign.
set -e
cd "${0:A:h}"
APP="build/YouTube Wallpaper.app"
PLIST="$APP/Contents/Info.plist"
rm -rf build && mkdir -p build

osacompile -l JavaScript -s -o "$APP" src/engine.js
cp src/panel.html "$APP/Contents/Resources/"

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" 2>/dev/null || true; }
pb "Delete :LSUIElement";              pb "Add :LSUIElement bool true"
pb "Set :CFBundleIdentifier com.feldberg.ytwallpaper" ; pb "Add :CFBundleIdentifier string com.feldberg.ytwallpaper"
pb "Delete :CFBundleDisplayName";      pb "Add :CFBundleDisplayName string YouTube Wallpaper"
pb "Delete :CFBundleShortVersionString"; pb "Add :CFBundleShortVersionString string 1.0"
pb "Delete :NSAppleEventsUsageDescription"
pb "Add :NSAppleEventsUsageDescription string YouTube Wallpaper takes the YouTube video playing in Chrome and hands it back when you turn the wallpaper off."

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
codesign --force --deep -s - -r='designated => identifier "com.feldberg.ytwallpaper"' "$APP" >/dev/null 2>&1
if [[ "$1" != "--no-install" ]]; then
  osascript -e 'quit app "YouTube Wallpaper"' >/dev/null 2>&1 || true
  pkill -f "YouTube Wallpaper.app/Contents/MacOS" 2>/dev/null || true
  rm -rf "/Applications/YouTube Wallpaper.app"
  cp -R "$APP" /Applications/
  touch "/Applications/YouTube Wallpaper.app"
  echo "Installed /Applications/YouTube Wallpaper.app"
fi
