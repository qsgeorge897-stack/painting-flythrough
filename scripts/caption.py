"""Step 5 - burn the artwork caption into rendered frames (fade in/out, dark gradient band for legibility).

    python3 scripts/caption.py frames/starry frames/starry_cap --start 26.6 --end 31.5 \
        --line1 "文森特·梵高 ｜《星月夜》 1889年 ｜ 布面油画" \
        --line2 "现藏于纽约现代艺术博物馆（MoMA），73.7 cm × 92.1 cm"

Frames are numbered JPGs from render.js (00000.jpg ...). Frames outside [start, end] are copied unchanged.
Font: Noto Sans CJK (apt install fonts-noto-cjk) or pass --font /path/to/font.ttc --font-index N.
Always check museum / date / size on the museum's own page before publishing.
"""
import argparse, os, shutil
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--fps", type=float, default=30)
ap.add_argument("--start", type=float, required=True, help="caption fade-in start (s)")
ap.add_argument("--end", type=float, required=True, help="caption fully gone (s)")
ap.add_argument("--fade", type=float, default=0.8)
ap.add_argument("--line1", required=True); ap.add_argument("--line2", default="")
ap.add_argument("--position", choices=["top", "bottom"], default="top")
ap.add_argument("--font", default="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
ap.add_argument("--font-index", type=int, default=2, help="2 = Simplified Chinese face in NotoSansCJK .ttc")
ap.add_argument("--band", type=float, default=150, help="max darkness (0-255) of the gradient behind the text")
a = ap.parse_args()

os.makedirs(a.dst, exist_ok=True)
files = sorted(f for f in os.listdir(a.src) if f.endswith(".jpg"))
W, H = Image.open(os.path.join(a.src, files[0])).size
k = H / 1080
f1 = ImageFont.truetype(a.font, int(36 * k), index=a.font_index)
f2 = ImageFont.truetype(a.font, int(26 * k), index=a.font_index)
bh = int(200 * k)
band = Image.new("L", (W, H), 0); bd = ImageDraw.Draw(band)
for y in range(bh):
    yy = y if a.position == "top" else H - 1 - y
    bd.line([(0, yy), (W, yy)], fill=int(a.band * (1 - y / bh) ** 1.5))
y1 = int(34 * k) if a.position == "top" else H - int(130 * k)
y2 = y1 + int(52 * k)
ramp = lambda t, x, y: max(0.0, min(1.0, (t - x) / (y - x)))
for fn in files:
    t = int(fn[:5]) / a.fps
    al = ramp(t, a.start, a.start + a.fade) * (1 - ramp(t, a.end - a.fade * 0.6, a.end))
    if al <= 0:
        shutil.copy(os.path.join(a.src, fn), os.path.join(a.dst, fn)); continue
    im = Image.open(os.path.join(a.src, fn)).convert("RGBA")
    dark = Image.new("RGBA", im.size, (8, 12, 30, 0)); dark.putalpha(band.point(lambda v: int(v * al)))
    im = Image.alpha_composite(im, dark)
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    for txt, font, y in [(a.line1, f1, y1), (a.line2, f2, y2)]:
        if not txt: continue
        x = (W - d.textlength(txt, font=font)) / 2
        d.text((x + 2, y + 2), txt, font=font, fill=(0, 0, 0, int(170 * al)))
        d.text((x, y), txt, font=font, fill=(248, 242, 222, int(255 * al)))
    Image.alpha_composite(im, ov).convert("RGB").save(os.path.join(a.dst, fn), quality=95)
print(f"captioned {len(files)} frames -> {a.dst}")
