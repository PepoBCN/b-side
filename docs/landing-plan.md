# Landing page plan

12 Oct 2026. Plan only, nothing built yet. Issues and epics are on GitHub, linked at the end.

## Goal

A one-page site that shows the app working in the first five seconds, gets a Mac user from "what is this" to a running wallpaper with no surprises, and links to the code. It should feel like it came out of a record shop or a late-night radio station, not a SaaS template.

## Design direction

The references below were read directly from the live sites (their CSS, not screenshots of screenshots). They share one pattern: a condensed grotesk for headlines, a monospace for labels and data, near-black and off-white, and one loud accent.

1. [NTS Radio](https://www.nts.live): Univers Condensed, black and off-white, a live "now playing" bar across the top. Take the bar, but fill it with real information (version, macOS requirement, price: free).
2. [Boiler Room](https://boilerroom.tv): video first, the footage is the hero, acid accent (#e6ff13) used sparingly. Take the full-bleed video hero and the restraint with colour.
3. [Teenage Engineering](https://teenage.engineering): product pages read like a spec sheet, small type, grids, numbers, orange used as a signal. Take the spec table for what the app does and needs.
4. [Nothing](https://nothing.tech): dot-matrix and mono labels (Ndot, Geist Mono). Take mono labels for UI callouts and section numbers.
5. [Raycast](https://www.raycast.com): the honest Mac utility pattern, real screenshots of the real app, keyboard shortcuts shown as keys. Take the annotated screenshot and the `<kbd>` treatment.

### What we take

1. Colours: near-black `#0b0b0b`, off-white `#f2f0ea`, mid grey for secondary text, and one accent, the app's own red `#ff3b5c` (already the panel accent and the warm end of the icon gradient). No second accent.
2. Type (Google Fonts): Archivo with its width axis for condensed headlines (the free stand-in for Univers Condensed), Archivo at normal width for body, JetBrains Mono for labels, numbers, the `ytwall` block and section markers.
3. Big condensed uppercase headlines, small body text, generous black space, hard edges. Rounded corners only where the macOS UI itself is rounded (the panel screenshot).
4. Motion only where it shows the product: the hero loop and the mode switcher. Nothing floats, fades in on scroll or parallaxes.

### What we refuse

1. Gradient blobs, glassmorphism cards, glowing borders.
2. A row of three icon cards with one-line benefits.
3. Invented testimonials, user counts, star ratings or "trusted by" logos.
4. Stock photos, 3D renders, AI images.
5. Copy like "unlock", "elevate", "seamless", "your desktop, reimagined".
6. YouTube's logo, red play button or wording that suggests it's affiliated.

## Page, top to bottom

| # | Section | What it shows | Real asset it needs |
|---|---|---|---|
| 1 | Live bar | `v1.0 · macOS 13+ · free · open source` plus the download link | Version from the latest GitHub release |
| 2 | Hero | Full-bleed loop of a real desktop with a video playing behind real windows. One condensed headline, one line of plain explanation, Download and GitHub buttons | 10 to 15 s screen recording, poster frame |
| 3 | Modes | A switcher: Wallpaper, Screensaver, Back to Chrome. Each tab swaps a real capture and a two-line explanation | Three captures of the same moment in each mode |
| 4 | The panel | The control panel screenshot with numbered mono callouts (now playing, transport, modes, look, recents, settings) | Panel screenshot at 2x |
| 5 | Every screen | Two screens playing the same video, "sound comes from the main screen" | Two-screen capture or a clean diagram |
| 6 | Spec sheet | What it does and needs, as a table: screens, sound, pauses on lock and battery, idle screensaver, recents, requirements, size, privacy (no tracking, no account) | Facts from the app and the release |
| 7 | Terminal | The `ytwall` commands, copyable | README text |
| 8 | Install | Honest steps: download, unzip, move to Applications, the Gatekeeper "Open Anyway" step, the Chrome permission prompt | Screenshots of both macOS prompts |
| 9 | Changelog and footer | Latest release notes, GitHub link, licence, "Not affiliated with YouTube or Google" | Release notes |

## Order of work

1. Decisions (epic 1). The name gates everything: repo name, bundle id, zip name, every screenshot and every line of copy.
2. Rename and release pipeline (epic 2), so there is a real download and a real version number.
3. Assets (epic 3), captured from the renamed app on a clean desktop.
4. Build the page (epic 4).
5. QA, then deploy only on Josh's go (epic 5).

## Known constraints

1. The app is signed ad hoc, not notarised. macOS 15 and later block it on first open until the user clicks Open Anyway in System Settings > Privacy & Security. The page has to say this plainly unless Josh pays for an Apple Developer account.
2. Music videos and album art are copyrighted, and this is a promotional page. Demo footage comes from Creative Commons or public domain videos (Blender open movies, NASA) or Josh's own footage. No Eminem.
3. Captures must come from a clean desktop or a separate macOS user. Nothing personal on screen: files, chats, mail, tabs.
4. The GitHub link and the download only work once the repo is public.
5. Taking a video from Chrome works in Chrome only today. Other browsers are logged as a separate issue, not part of v1.

## Tracking

Epics and issues: [github.com/PepoBCN/youtube-wallpaper/issues](https://github.com/PepoBCN/youtube-wallpaper/issues), label `epic` for the five epics, `josh` for decisions and checks, `claude` for build work.
