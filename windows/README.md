# B-Side for Windows

Paste a YouTube video, playlist or mix and it plays as your desktop wallpaper, behind the icons, on every screen, with sound. Or switch it to screensaver mode and it covers everything until you click or press a key.

This is the Windows version of [B-Side](../README.md). It is a separate app (Electron), not a port of the Mac code, so it is much bigger than the Mac one (over 100 MB, the Mac app is about 1 MB) and has a few differences listed below. Free, MIT licence.

## Install

1. Download `B-Side-Setup.exe` from the [Windows release](https://github.com/PepoBCN/b-side/releases) (the release called "B-Side for Windows", tag `win-v...`). Do not use the "latest" release, that one is the Mac app.
2. Run it. It installs for your user only, no administrator rights needed, and starts B-Side when it finishes.
3. The app is not signed, so Windows SmartScreen shows "Windows protected your PC". Click "More info", then "Run anyway". It is the same idea as the "Open Anyway" step on the Mac. If you would rather not, check the SHA-256 file next to the download first.

Prefer no installer? Download `B-Side-Windows.zip`, unzip it anywhere and run `B-Side.exe`.

To remove it, use Settings, Apps, B-Side, Uninstall. Your settings stay in `%APPDATA%\B-Side` until you delete that folder.

## Using it

1. Click the B-Side tray icon (bottom right, it may be under the arrow) to open the panel.
2. Paste a YouTube link and press Enter. Or copy a link anywhere and press `Ctrl+Alt+B`.
3. Pick Wallpaper or Screensaver. The panel also has volume, dim, fill, all screens or main screen only, recents and the settings (pause on lock, pause on battery, screensaver after idle, resume on launch, launch at login, skip still pictures).

Sound comes from the main screen only. The other screens are muted and follow the main one, so every screen shows the same second.

### Shortcuts

| Keys | Does |
|---|---|
| `Ctrl+Alt+B` | Plays the link on the clipboard. If there is none, sends the video back to your browser at the same second, or opens the panel when nothing is playing |
| `Ctrl+Alt+P` | Pause or play |
| `Ctrl+Alt+Right` / `Ctrl+Alt+Left` | Next or previous video in a playlist |
| `Ctrl+Alt+S` | Wallpaper or screensaver |
| `Ctrl+Alt+M` | Mute |

If another program already owns one of these, the panel says which ones did not register.

### Command line

`bside.cmd` (in the install folder, under `resources`) hands a command to the running app. Put that folder on your PATH if you want `bside` everywhere.

```
bside                       open the control panel
bside <youtube link>        play that link
bside pause | next | prev | mute | louder | quieter | wallpaper | screensaver | resume
bside vol 50 | dim 30 | screens all|main | fill on|off
bside off                   back to your browser at the same second
bside stop | quit           turn the wallpaper off | quit the app
bside status                what is playing, written to %APPDATA%\B-Side\status.json
```

You can call the app directly too, `B-Side.exe --cmd "next"`. A second launch never starts a second copy, it passes the command to the first one.

## Known limits

1. No "take the video that is open in Chrome". Windows has no equivalent of the Mac's AppleScript hook. Copy the link and press `Ctrl+Alt+B` instead.
2. No YouTube Premium "No ads" sign-in. Google blocks signing in inside an embedded window, so the option is gone.
3. Over 100 MB, because it carries its own browser engine.
4. Unsigned, so SmartScreen warns on first run.
5. Some videos cannot be embedded. The owner has switched embedding off, and the panel says so. Mixes made mostly of audio uploads with a still picture are skipped by default.
6. Windows 10 and 11 on 64-bit Intel or AMD only. Windows on Arm is not built.

## Build and test

You need Node 24. Run everything from this folder (`windows/`).

```
npm ci                      install dependencies
npm start                   run the app from source
npm test                    unit tests (no Electron, runs on any OS)
npm run dist                build dist/B-Side-Setup.exe and dist/B-Side-Windows.zip (use a Windows machine)
npx playwright test         end-to-end tests against the real app
node tools/ci-verdict.js    what the last e2e run proved
```

End-to-end tests drive the real app through Playwright's Electron support.

1. On Windows against the packaged app. Install it, then `set BSIDE_EXE=C:\path\to\B-Side.exe` and run `npx playwright test`.
2. On a Mac or Linux against the source. Just run `npx playwright test`. It starts `electron .` with `BSIDE_TEST=1 BSIDE_MUTE=1 BSIDE_SMALL=1`, so the windows are small, never fullscreen and never audible. The Windows-only checks (WorkerW and Progman parenting, top-most through user32, desktop screenshots) are skipped with a reason.

Useful switches.

1. `BSIDE_EXE` the exe to test. Unset means `electron .`.
2. `E2E_ARTIFACTS` where JSON, screenshots and logs go. Default `dist/e2e-artifacts`.
3. `BSIDE_E2E_VIDEO` and `BSIDE_E2E_PLAYLIST` replace the official test video and playlist.
4. `E2E_DESKTOP_SHOT=1` takes full-desktop screenshots on a Mac too (it captures your screen, so leave it off unless you mean it).
5. `tools/verify-wallpaper.js` is a separate diagnostic. `npx electron tools/verify-wallpaper.js --out tree.json --shot wallpaper.png` attaches a magenta test window behind the icons, dumps the shell window tree and counts the magenta pixels on screen. Add `--require-visible` to fail when none shows.

## How CI proves it

There is no Windows machine behind this project, so the proof is `.github/workflows/windows.yml`, which runs on GitHub's `windows-latest` runner on every push or pull request that touches `windows/`. It does this.

1. Installs dependencies, runs the unit tests and builds the installer and the zip.
2. Opens the zip and checks the exe, the asar and koffi's native Windows binary are really inside.
3. Installs the real NSIS installer silently, checks the Start menu shortcut and that no desktop shortcut was made.
4. Runs the wallpaper diagnostics, once plain and once requiring the test colour to be visible on screen.
5. Runs the Playwright tests against the installed exe. It launches the app, hands over a second launch, plays a real official video and checks the player state is 1 and the clock moves over 5 seconds, checks one player per screen and the status JSON, drives pause, play, mute, volume, mode, next and previous, asks Windows (user32) which class the player window is parented to, tests the screensaver (top-most, a click inside the 3 second grace period is ignored, a later click ends it), and feeds a bad link to check the error shows while playback continues.
6. Takes full-desktop screenshots before, during and after, and uploads the installer, zip, checksums, JSON dumps, logs, the Playwright report and the screenshots as artefacts.
7. Uninstalls silently and checks the files are gone.
8. On a tag called `win-v...` it publishes a GitHub release with `--latest=false`, so the Mac download link keeps pointing at the Mac app.

If YouTube refuses to play on the runner (a datacentre address can get "Sign in to confirm you're not a bot" or error 150 or 152), the playback tests fail loudly and the run records `blocked-by-youtube` in `youtube-status.json`. That is not the same as an app fault, and the verdict says so.

### What CI cannot prove

1. Real sound output. The runner has no speakers, and the tests mute the player anyway.
2. More than one monitor. The runner has one display, so follower screens and per-screen layout are only checked by logic.
3. High-DPI scaling and mixed-DPI setups.
4. What SmartScreen shows a person. The runner skips that prompt.
5. A human's first run, including how it feels and whether the wallpaper looks right. The screenshots are there for a person to look at.
6. Windows 10, Windows on Arm and older builds. The runner is one recent Windows Server image.
