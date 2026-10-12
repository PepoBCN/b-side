# B-Side

A free Mac app that plays a YouTube video, playlist or mix as your desktop wallpaper, on every screen and every desktop, with sound. Switch it to screensaver mode to cover everything, or hand the video back to Chrome at the second it had reached.

[Download the latest release](https://github.com/PepoBCN/b-side/releases/latest) · macOS 13 or later · MIT licence

## What it does

1. Takes the YouTube video playing in Chrome (or a pasted link) and puts it behind every window on all your screens.
2. Plays the sound from the main screen only. The other screens follow the main one: same video, same second.
3. Screensaver mode covers every screen, menu bar and Dock included. A click, a key or moving the mouse drops back to wallpaper.
4. Back to Chrome reopens the video in a normal tab where it had got to, playlist included.
5. Control panel: now playing with thumbnail, seek bar, previous, play and next, mute and volume, dim, fill or fit, all screens or main only, recents and settings.
6. Pauses itself when the Mac locks or the displays sleep (and on battery, if you switch that on), then carries on.
7. Skips the odd "Topic" upload in a mix (audio with a still album cover), and tells you when a whole mix is like that.
8. Optional: screensaver after 2 to 15 minutes idle, resume the last video when the app opens, open at login.

## Install

1. Download `B-Side-1.0.zip` from [Releases](https://github.com/PepoBCN/b-side/releases/latest) and unzip it.
2. Drag **B-Side** into Applications and open it.
3. macOS will say it can't check the app, because it isn't notarised by Apple. Go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway**. You only do this once.
4. The first time B-Side takes a video from Chrome, macOS asks whether it may control Google Chrome. Click **Allow**.

To start from the exact second you were at in Chrome, rather than the start of the video, turn on Chrome's **View > Developer > Allow JavaScript from Apple Events**. Going back to Chrome is always exact.

## Using it

1. Open B-Side. The control panel appears.
2. With a YouTube video open in Chrome, press **Play as wallpaper** or **Screensaver**. Or paste a link.
3. Open the app again at any time to bring the panel back. The ♫ menu bar icon does the same (if a menu bar manager such as Ice or Bartender hides it, drag it out of the hidden section).
4. In the panel: <kbd>Space</kbd> play or pause, <kbd>←</kbd> <kbd>→</kbd> change track, <kbd>M</kbd> mute, <kbd>↑</kbd> <kbd>↓</kbd> volume, <kbd>⌘W</kbd> hide.

Mixes look best started from an official music video. A mix started from a "Topic" upload is mostly still album covers.

## Terminal

`bin/bside` drives the app. Link it into your PATH, for example `ln -s "$PWD/bin/bside" ~/.local/bin/bside`.

```
bside                  open the control panel
bside on [screensaver] take the YouTube video open in Chrome
bside <youtube link>   play that link
bside off              back to Chrome at the same second
bside stop | quit      turn the wallpaper off | quit the app
bside pause|next|prev|mute|louder|quieter|wallpaper|screensaver|resume
bside status           what's playing, as JSON
bside vol 50 | dim 30 | screens all|main | fill on|off
```

## Building from source

```
./build.sh              build and install to /Applications
./build.sh --no-install build into build/ only
./build.sh --release    build and zip into build/ with a SHA-256
```

Everything it needs ships with macOS: `osacompile`, `PlistBuddy`, `qlmanage`, `sips`, `iconutil` and `codesign`. No Xcode.

## How it works

1. `src/engine.js` is a JavaScript for Automation script compiled into a stay-open applet. It uses the Cocoa bridge to open one borderless window per screen at desktop level, each with a `WKWebView` running YouTube's own embed player.
2. The main screen's player owns the playlist and the sound and reports its state (video, second, play state) once a second. The app tells the other screens' muted players to match. YouTube mixes reshuffle on every load, so this keeps every screen on the same track.
3. Screensaver mode raises the same windows to screensaver level and puts a view on top that ends it on any input.
4. `src/panel.html` is the control panel, a web page in a floating window with macOS vibrancy. Buttons post messages to the app through `WKScriptMessageHandler`, and the app pushes state back every second.
5. The terminal tool sends the same commands over a distributed notification (`bside.cmd`).
6. The app is signed ad hoc with an identifier-only requirement, so macOS keeps the Chrome permission across rebuilds.

Settings and recents live in `~/Library/Application Support/B-Side/state.json`. Errors go to `~/Library/Logs/B-Side.log`. Nothing is sent anywhere: no account, no analytics.

## Limits

1. Taking a video from the browser works with Chrome only for now.
2. Some videos block playing outside YouTube. The panel says so and playlists skip on to the next track.
3. No global keyboard shortcuts yet.

## Licence

MIT. B-Side is not affiliated with, endorsed by or connected to YouTube or Google. Videos play through YouTube's own embed player and remain subject to YouTube's terms.
