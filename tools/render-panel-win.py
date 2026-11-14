# Renders the real Windows control panel (windows/src/panel.html) with sample state into
# docs/assets/panel-win.png and panel-win-full.png, so the landing page shows the actual UI.
#   python3 tools/render-panel-win.py
import pathlib
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[1]
state = {
    "on": True, "mode": "wallpaper", "error": None, "pausedBy": None, "screens": 2,
    "now": {"id": "_JZom_gVfuw", "title": "The Notorious B.I.G. - Juicy (Official Video)", "author": "The Notorious B.I.G.",
            "t": 97, "d": 302, "playing": True, "buffering": False, "list": True},
    "settings": {"volume": 70, "muted": False, "dim": 25, "fill": True, "screens": "all", "pauseOnLock": True,
                 "pauseOnBattery": False, "idleSaver": 5, "resumeOnLaunch": False, "launchAtLogin": True,
                 "skipStill": True, "shortcuts": True, "cli": True},
    "recents": [
        {"id": "_JZom_gVfuw", "list": "RD_JZom_gVfuw", "title": "The Notorious B.I.G. - Juicy (Official Video)"},
        {"id": "TIy3n2b7V9k", "list": None, "title": "Avril Lavigne - Sk8er Boi (Official Video)"},
        {"id": "phaJXp_zMYM", "list": None, "title": "The Notorious B.I.G. - Big Poppa (Official Music Video)"},
        {"id": "5NPBIwQyPWE", "list": None, "title": "Avril Lavigne - Complicated (Official Video)"},
    ],
    "canResume": True, "version": "1.0.0", "players": 2, "followers": ["_JZom_gVfuw"], "panelOpen": True,
    "shortcuts": {"enabled": True, "registered": ["browser", "play", "prev", "next", "saver", "mute"], "failed": []},
    "wallpaper": {"method": "workerw", "parentClass": "WorkerW"}, "platform": "win32",
}
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    for name, h, full in (("panel-win", 592, False), ("panel-win-full", 700, True)):
        pg = b.new_page(viewport={"width": 380, "height": h}, device_scale_factor=2)
        pg.goto((root / "windows/src/panel.html").as_uri())
        pg.evaluate("s => window.render(s)", state)
        pg.wait_for_timeout(5000)
        pg.screenshot(path=str(root / f"docs/assets/{name}.png"), full_page=full)
    b.close()
print("ok")
