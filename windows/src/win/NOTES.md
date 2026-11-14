# Wallpaper attach on Windows: research notes (14 Nov 2026)

Nothing here was run on Windows. "Certain" means stated by a primary source or shipping code. "Inferred" is my reading.

## Certain

1. **Classic technique (Windows 10, Windows 11 before 24H2).** Send message `0x052C` to `Progman`. Explorer then creates a WorkerW that sits behind the one hosting `SHELLDLL_DefView` (the icons). Enumerate top-level windows, find the one with a `SHELLDLL_DefView` child, take the next top-level `WorkerW` sibling, `SetParent` your window to it. Source: Lively, `WinDesktopCore.SetupDesktopLayer` and `TryAttachToDesktop`, https://github.com/rocksdanister/lively/blob/HEAD/src/Lively/Lively/Core/WinDesktopCore.cs . Lively sends `wParam=0xD, lParam=1`.
2. **Windows 11 24H2 (build 26100+) "raised desktop".** `Progman` gets `WS_EX_NOREDIRECTIONBITMAP`, `SHELLDLL_DefView` becomes a `WS_EX_LAYERED` child of `Progman`, and the wallpaper is a `WorkerW` child of `Progman` z-ordered below it. Parenting into that WorkerW (or into Progman without the layered bit) is not drawn. Microsoft's guidance, relayed by the Lively author: create your own `WS_EX_LAYERED` child of `Progman`, z-ordered under DefView and above the WorkerW, with `SetLayeredWindowAttributes(alpha 255)`. Source: https://github.com/rocksdanister/lively/issues/2074 (comment of 2024-04-01) and the same text in `SetupDesktopLayer`.
3. **Lively's raised-desktop attach.** Add `WS_CHILD`, add `WS_EX_LAYERED` + alpha 255, `SetParent(progman)`, `SetWindowPos(hwnd, insertAfter = DefView, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)`, then make sure the WorkerW is the last child (`HWND_BOTTOM`). Same file as item 1 (`TryAttachToDesktop`, `EnsureWorkerWZOrder`). Lively skips the `SPI_SETDESKWALLPAPER` refresh on a raised desktop because it destroys the WorkerW.
4. **Lively reacts to Explorer restart** with `WM_TASKBARCREATED` (compares the explorer PID) and recreates wallpapers; it also hooks `EVENT_OBJECT_DESTROY` on the WorkerW thread. Same file.
5. **`SetParent` rules.** It does not change `WS_CHILD`/`WS_POPUP`. Before parenting a popup, clear `WS_POPUP` and set `WS_CHILD`. After `SetParent(NULL)`, clear `WS_CHILD` and set `WS_POPUP`. https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent
6. **Electron specifics.** `BrowserWindow.getNativeWindowHandle()` returns a Buffer holding the HWND. `screen.dipToScreenRect(window, rect)` (win32 only) converts DIP to physical pixels. Types in `node_modules/electron/electron.d.ts`.
7. **koffi 3.** Pointers are BigInt, `intptr` returns a JS number, `_Out_` primitives take a one-element array, `_Out_` structs take `{}`, `__stdcall` is accepted in prototypes, a plain JS function can be passed as a transient callback. Checked by running probes on macOS against libSystem, and against the shipped docs in `node_modules/koffi/doc`. `@koromix/koffi-win32-x64` is in `package-lock.json` as an optional dependency.

## Found in third-party code (real reports, not Microsoft)

1. A raised desktop is only "capable" of the split. On build 26300.9711 (26H2) with no WorkerW yet, DefView paints the static wallpaper over your window, so `0x052C (0xD,1)` still has to be sent when no full-screen WorkerW exists. Extra variants with `lParam=0` can undo the split. Explorer also keeps several tiny WorkerW helper windows, so pick the one covering about the whole screen. Source: https://github.com/p4yy/Intonaco (`DesktopIntegration.cs`, PR 5).
2. Reports that classic `SetParent`-to-WorkerW passes every check but never renders on 24H2/25H2: https://github.com/YUSUF-CGRC/video-loop-wallpaper/issues/1, https://github.com/Sean-CIS/WallPaper-Engineering/pull/2, https://github.com/wakewakame/GravityDesktop2/pull/2 (this one also found `WS_EX_LAYERED` must exist before the swap chain is created, relevant to Chromium's DirectComposition surface).
3. `electron-as-wallpaper` (Rust addon) uses the classic method with a fallback to a WorkerW child of Progman, no 24H2 handling: https://github.com/meslzy/electron-as-wallpaper (`src/attach.rs`).

## Inferred (needs a real Windows run)

1. Whether Chromium's window renders correctly once `WS_EX_LAYERED` is added to an already created Electron HWND. Lively does the same to CEF/WebView2 windows and works. If the screenshot check in `tools/verify-wallpaper.js` shows no magenta on a 24H2 runner, creating the BrowserWindow with `transparent: true` (which makes it layered from creation) is the next thing to try.
2. Whether `SetParent` between Electron (per-monitor DPI aware) and Explorer's windows behaves at scales other than 100%. Child positions are `physicalRect - GetWindowRect(parent).origin`. This assumes Progman/WorkerW have no non-client area, so client origin equals window origin. CI runs at 100% and cannot check it.
3. The `bottom` fallback. `HWND_BOTTOM` alone would put the window under Progman and hide it, so the code also pushes Progman and any wallpaper WorkerW to the bottom. That makes the window sit over the icons. It is a degraded mode, not a design goal.
4. Explorer restart destroys Progman, and a child window normally dies with its parent. So the Electron window is likely destroyed, not orphaned. `reattachAll()` returns `destroyed: true` for those, and the app (lane A) has to create a new BrowserWindow and call `attach` again. If the HWND does survive, `reattachAll()` re-attaches it to the new Progman.
5. Chromium may treat the window as occluded and pause video. The verify tool sets `disable-features=CalculateNativeWinOcclusion`, `disable-backgrounding-occluded-windows` and `disable-renderer-backgrounding`; I recommend the app does too, plus `backgroundThrottling: false`. Not confirmed for Electron 45.
6. Hidden desktop icons (right click, View, Show desktop icons off) were mentioned in the Lively thread as something to rule out. Not tested.

## Rules the code follows

1. Classify the layout at runtime. Raised wins over classic, so a stale top-level WorkerW on a 24H2 box is never used.
2. Verify after every attach (parent, parent class, visible, size, layered bit, z-order index = DefView + 1 and WorkerW below). A failed check undoes the attempt and falls through: raised: Progman child, WorkerW child, bottom. classic: WorkerW, bottom.
3. After attach the app must not call `setBounds`, `setSize` or `show` on the window. Call `attach` again with the new DIP rect (display change), or `reattachAll()`.
4. Window state is restored from the styles saved before attach, so `detach` gives back the original top-level window.
