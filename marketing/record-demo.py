# Records the live B-Side site demo (the Juicy desktop mock) and cuts a 14 second mp4 for LinkedIn.
#   python3 marketing/record-demo.py   -> marketing/bside-post-video.mp4
import glob, os, pathlib, shutil, subprocess
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
raw = here / "rec-raw"
shutil.rmtree(raw, ignore_errors=True)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--autoplay-policy=no-user-gesture-required", "--mute-audio"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, record_video_dir=str(raw),
                        record_video_size={"width": 1440, "height": 900})
    pg = ctx.new_page()
    pg.goto("https://bsideapp.netlify.app/", wait_until="networkidle")
    pg.wait_for_timeout(1000)
    pg.evaluate("""()=>{const d=document.getElementById('desk');const r=d.getBoundingClientRect();
      window.scrollBy(0,r.top-40);document.documentElement.style.overflow='hidden';}""")
    pg.wait_for_timeout(27000)
    ctx.close(); b.close()
src = glob.glob(str(raw / "*.webm"))[0]
out = here / "bside-post-video.mp4"
# first 11.3s skips the page load and the raw player flash, crop to the desk, 14.5s of the demo cycle
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "11.3", "-i", src, "-t", "14.5",
                "-vf", "crop=1144:714:148:41", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24",
                "-movflags", "+faststart", "-an", str(out)], check=True)
shutil.rmtree(raw, ignore_errors=True)
print(out, os.path.getsize(out))
