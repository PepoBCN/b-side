# YouTube Wallpaper

A Mac app that plays a YouTube video, playlist or mix as your desktop wallpaper, on every screen and every desktop, with sound. It can also cover everything like a screensaver, and hand the video back to Chrome at the second it had reached.

## What it does

1. Takes the YouTube video playing in Chrome (or a pasted link) and puts it behind every window on all your screens.
2. Plays the sound from the main screen only. The other screens follow the main one, same video, same second.
3. Screensaver mode covers every screen, menu bar and Dock included. A click, a key or moving the mouse drops back to wallpaper.
4. Back to Chrome reopens the video in a normal tab where it had got to, playlist included.
5. Control panel: now playing with thumbnail, seek bar, previous / play / next, mute and volume, dim, fill or fit, all screens or main only, recents and settings.
6. Pauses itself when the Mac locks or the displays sleep (and on battery, if you switch that on), then carries on.
7. Optional: screensaver after 2 to 15 minutes idle, resume the last video when the app opens, open at login.

## Using it

1. Open **YouTube Wallpaper** from Spotlight or Applications. The control panel appears.
2. With a YouTube video open in Chrome, press **Play as wallpaper** or **Screensaver**.
3. Open the app again at any time to bring the panel back. The ♫ menu bar icon does the same (if Ice or Bartender hide it, drag it out of the hidden section).
4. In the panel: <kbd>Space</kbd> play or pause, <kbd>←</kbd> <kbd>→</kbd> change track, <kbd>M</kbd> mute, <kbd>↑</kbd> <kbd>↓</kbd> volume, <kbd>⌘W</kbd> hide.

The first time it takes a video from Chrome, macOS asks whether YouTube Wallpaper may control Google Chrome. Allow it.

To start from the exact second you were at in Chrome (not just the start of the video), turn on Chrome's **View > Developer > Allow JavaScript from Apple Events**. Going back to Chrome is always exact.

## Terminal

`bin/ytwall` drives the app (symlink it into your PATH):

```
ytwall                  open the control panel
ytwall on [screensaver] take the YouTube video open in Chrome
ytwall <youtube link>   play that link
ytwall off              back to Chrome at the same second
ytwall stop | quit      turn the wallpaper off | quit the app
ytwall pause|next|prev|mute|louder|quieter|wallpaper|screensaver|resume
ytwall status           what's playing, as JSON
ytwall vol 50 | dim 30 | screens all|main | fill on|off
```

## Building

```
./build.sh              build and install to /Applications
./build.sh --no-install build into build/ only
```

Everything it needs ships with macOS: `osacompile`, `PlistBuddy`, `qlmanage`, `sips`, `iconutil` and `codesign`. No Xcode.

## How it works

1. `src/engine.js` is a JavaScript for Automation script compiled into a stay-open applet. It uses the Cocoa bridge to open one borderless window per screen at desktop level, each with a `WKWebView` running the YouTube iframe player.
2. The main screen's player owns the playlist and the sound and writes its state (video, second, play state) into its page title once a second. The app reads that and tells the other screens' muted players to match. YouTube mixes reshuffle on every load, so this keeps all screens on the same track.
3. Screensaver mode raises the same windows to screensaver level and puts a view on top that ends it on any input.
4. `src/panel.html` is the control panel, a web page in a floating window with macOS vibrancy. Buttons post messages to the app through `WKScriptMessageHandler`, and the app pushes state back every second.
5. The terminal tool and the panel send the same commands. The terminal uses a distributed notification (`ytwall.cmd`).
6. The app is signed ad hoc with an identifier-only requirement, so the Chrome permission survives rebuilds.

Settings and recents live in `~/Library/Application Support/YouTube Wallpaper/state.json`. Errors go to `~/Library/Logs/YouTube Wallpaper.log`.

## Limits

1. Some videos block playing outside YouTube. The panel says so and playlists skip on to the next track.
2. No global keyboard shortcuts yet (they need Accessibility permission and a compiled helper).
3. The name uses YouTube's trademark, which is fine for personal use. Rename before publishing it anywhere.
