# Renders tools/og.html into docs/assets/og.jpg, the 1200x630 link preview (WhatsApp, iMessage, Slack, X).
#   python3 tools/render-og.py
import pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
    pg.goto((root / "tools/og.html").as_uri(), wait_until="networkidle")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=str(root / "docs/assets/og.jpg"), type="jpeg", quality=88)
    b.close()
print("ok")
