# Renders the real control panel (src/panel.html) with sample state into docs/assets/panel.png,
# so the landing page shows the actual UI without capturing anyone's desktop.
#   python3 tools/render-panel.py
import json, pathlib
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[1]
state = {
    "on": True, "mode": "wallpaper", "error": None, "pausedBy": None, "screens": 2,
    "now": {"id": "_JZom_gVfuw", "title": "The Notorious B.I.G. - Juicy (Official Video)", "author": "The Notorious B.I.G.",
            "t": 97, "d": 302, "playing": True, "buffering": False, "list": True},
    "settings": {"volume": 70, "muted": False, "dim": 25, "fill": True, "screens": "all", "pauseOnLock": True,
                 "pauseOnBattery": False, "idleSaver": 5, "resumeOnLaunch": False, "launchAtLogin": True,
                 "closeChromeTab": True, "skipStill": True},
    "recents": [
        {"id": "_JZom_gVfuw", "list": "RD_JZom_gVfuw", "title": "The Notorious B.I.G. - Juicy (Official Video)"},
        {"id": "TIy3n2b7V9k", "list": None, "title": "Avril Lavigne - Sk8er Boi (Official Video)"},
        {"id": "phaJXp_zMYM", "list": None, "title": "The Notorious B.I.G. - Big Poppa (Official Music Video)"},
        {"id": "5NPBIwQyPWE", "list": None, "title": "Avril Lavigne - Complicated (Official Video)"},
    ],
    "chrome": None, "canResume": True, "version": "1.2", "chromeJs": True, "shortcuts": {"enabled": True, "trusted": True}, "players": 2, "followers": ["_JZom_gVfuw"], "panelOpen": True,
}
chrome = """
html { background: #232325; }
body::before { content: ""; position: fixed; left: 14px; top: 14px; width: 12px; height: 12px; border-radius: 50%;
  background: #ff5f57; box-shadow: 20px 0 #febc2e, 40px 0 #28c840; }
"""
# The hero desktop on the site plays a public-domain 1940s Soundie, so its panel shows that.
hero = json.loads(json.dumps(state))
hero["now"].update({"id": None, "title": "A Jazz Etude (1940s Soundie)", "author": "Castle Films", "t": 22, "d": 160, "list": False})
poster = (root / "docs/assets/hero-poster.jpg").as_uri()
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    for name, h, full, st in (("panel", 700, False, state), ("panel-full", 700, True, state), ("panel-hero", 700, False, hero)):
        pg = b.new_page(viewport={"width": 380, "height": h}, device_scale_factor=2)
        pg.goto((root / "src/panel.html").as_uri())
        pg.add_style_tag(content=chrome + (f'#np-thumb {{ background-image: url("{poster}") !important; background-size: cover !important; }}' if st is hero else ""))
        pg.evaluate("s => window.render(s)", st)
        pg.wait_for_timeout(5000)
        pg.screenshot(path=str(root / f"docs/assets/{name}.png"), full_page=full)
    b.close()
print("ok")
