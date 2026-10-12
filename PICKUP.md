# Pickup: YouTube Wallpaper

Last updated 12 Oct 2026.

## State

1. v1.0 installed at `/Applications/YouTube Wallpaper.app`, repo PepoBCN/youtube-wallpaper (private).
2. Rebuild and reinstall with `./build.sh`. It quits the running app, so run `ytwall resume` afterwards.
3. `ytwall` is symlinked at `~/.local/bin/ytwall` -> `bin/ytwall`.
4. Chrome automation permission granted 12 Oct. The identifier-only signature keeps it across rebuilds; if the bundle id ever changes, macOS asks again.

## Tested 12 Oct (all via the same command path the panel uses, readings from `ytwall status`)

1. Take from Chrome (tab closes), both screens, panel render.
2. Next, previous, pause, play, mute, volume, seek bar data.
3. Follower screen on the same video id after next.
4. Dim, fill, main only and back to all screens (settles at one player per screen).
5. Screensaver in (window level 1000) and back to wallpaper.
6. Lock pause and resume (simulated `com.apple.screenIsLocked` / `Unlocked`).
7. Back to Chrome at the same second with the playlist.
8. Playlist starts on the chosen track and second (embed URL form).
9. Bad link error shows and fades, recents, login agent on and off, quit and resume.

## Next: landing page and public release (planned 12 Oct, not built)

Plan in `docs/landing-plan.md`. Epics #12 decisions, #17 release readiness, #23 design and assets, #27 build, #31 QA and launch. Name decided 12 Oct: **B-Side** (#7 closed). Next decisions: #8 public repo + licence, #9 hosting, #10 notarisation. Then #13 rename. Nothing gets built or deployed until Josh says so.

## Open issues

Everything open is on GitHub: #1 to #5 labelled `josh` (manual checks and one Chrome setting), #6 labelled `claude` (shortcuts), and the landing epics above.

## Not tested by Claude (needs a human)

1. Clicking panel buttons and the ♫ icon (the message path was proven in a spike, the buttons send the same commands).
2. Ending screensaver mode with a real click, key or mouse move.
3. Screensaver after idle and pause on battery (need real idle time or unplugging).
4. Plugging in or removing a screen (same rebuild code as the main only / all switch, which passed).

## Gotchas

1. Never drive Ice or the menu bar with System Events clicks: it opened a stuck Apple menu on 12 Oct.
2. In JXA, `evaluateJavaScript` needs a real JS function as completion handler; null or `$()` crashes the app.
3. Old WKWebViews keep playing after their window closes unless you load a blank page first (caused 9 stacked audio copies once).
4. headless Chrome hangs for the icon render; `qlmanage -t` is used instead. macOS 26 frames icons that aren't full bleed.
5. swiftc on this Mac is broken (Command Line Tools SDK headers missing), hence JXA.
6. Don't test with Eminem tracks (Josh, 12 Oct).
7. Start mixes from an official music video. A mix seeded from a 'Topic' upload is all still album covers and looks frozen (12 Oct). The app skips up to 3 stills in a row, then shows a hint. Josh's current mix: Juicy, `_JZom_gVfuw&list=RD_JZom_gVfuw`.

## Ideas not done

1. Global keyboard shortcuts.
2. Per-screen different videos.
3. Rename before ever publishing (YouTube trademark), now issue #7.
