# YouTube Wallpaper plan (12 Oct 2026)

## What the others do

| | Plash (free) | Backdrop / Wallper (paid) | This app |
|---|---|---|---|
| Source | any website | own 4K library, local files | YouTube (video, playlist, mix) |
| Sound | not documented | no (silent) | yes, from the main screen only |
| Screens | pick a display | all displays | all displays or main only, kept in sync |
| Control | menu bar menu, Browsing Mode | menu bar popover | control panel + menu bar + `ytwall` CLI |
| Smart pause | deactivate on battery | battery-aware pausing | battery, screen lock / display sleep |
| Look | opacity, invert colours | fill/fit | dim, fill or fit |
| Screensaver | no | lock screen playback (Wallper) | screensaver mode, auto after idle |
| Hand-off | n/a | n/a | take from Chrome, back to Chrome at the same second |
| History | list of websites | library | recents |
| Launch at login | yes | yes | yes |

## Adopting

1. Proper app (`/Applications/YouTube Wallpaper.app`), no Dock icon, named process, one Chrome permission prompt.
2. Control panel (dark, vibrancy) opened on launch, on re-launch and from the menu bar icon. Ice hides menu bar icons, so the panel is the main way in.
3. Now playing card: thumbnail, title, progress bar you can click to seek, previous / play / next, mute, volume.
4. Modes: wallpaper, screensaver (exit on click, key or mouse move), back to Chrome, turn off.
5. Look: dim slider, fill or fit, all screens or main only.
6. Smart pause on screen lock / display sleep (on by default) and on battery (off by default).
7. Screensaver after idle: off, 2, 5, 10 or 15 minutes.
8. Recents (last 12), paste a link, resume last video on launch, launch at login.
9. Errors shown in the panel (some videos block embedding), auto-skip in playlists.
10. `ytwall` CLI kept for scripting.

## Skipping

1. Global keyboard shortcuts: need Accessibility permission plus a compiled helper; the toolchain on this Mac is broken.
2. Browsing Mode (clicking inside the page): not needed for video.
3. Lock screen video (Wallper): needs private APIs.

## Build

- [x] Spike: stay-open JXA applet as the engine, status item, reopen handler
- [x] Spike: WKScriptMessageHandler for panel to engine messages
- [x] Engine rewrite (`src/engine.js`)
- [x] Control panel (`src/panel.html`)
- [x] Icon, `build.sh`, install to /Applications
- [x] CLI `bin/ytwall` pointed at the app
- [x] Test: both screens in sync, single player count, Chrome round trip, screensaver in/out, dim, fill, main-only, lock pause, panel render
- [x] Repo PepoBCN/youtube-wallpaper (private), README, PICKUP
