"""Monet example - textures for the procedural "open world" valley (?cut=open):
sky from Poppy Field, brush-detail texture, painted tree atlas. Needs img/poppy.jpg and img/allee.jpg.
    python3 scripts/extras/prep_openworld.py
"""
import numpy as np, cv2, math
from PIL import Image, ImageDraw, ImageFilter
rng = np.random.default_rng(11)
OUT = "web/data"
# ---- sky texture from Poppy Field sky
p = cv2.cvtColor(cv2.imread("img/poppy.jpg"), cv2.COLOR_BGR2RGB)
H, W = p.shape[:2]
sky = p[int(0.02*H):int(0.30*H), int(0.02*W):int(0.98*W)]
sky = cv2.resize(sky, (2048, 640), interpolation=cv2.INTER_AREA)
cv2.imwrite(f"{OUT}/ow_sky.jpg", cv2.cvtColor(sky, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
# ---- detail (brush) texture: high-pass luminance from painting ground areas, tileable via mirror
srcs = []
for k, box in [("poppy", (0.05, 0.62, 0.55, 0.98)), ("allee", (0.25, 0.70, 0.75, 0.98))]:
    im = cv2.cvtColor(cv2.imread(f"img/{k}.jpg"), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    h, w = im.shape
    c = im[int(box[1]*h):int(box[3]*h), int(box[0]*w):int(box[2]*w)]
    c = cv2.resize(c, (1024, 1024), interpolation=cv2.INTER_AREA)
    hp = c - cv2.GaussianBlur(c, (0, 0), 14)
    hp = hp / (np.abs(hp).max() * 0.5)
    srcs.append(np.clip(hp * 0.5 + 0.5, 0, 1))
det = np.stack([srcs[0], srcs[1], np.zeros_like(srcs[0])], -1)
cv2.imwrite(f"{OUT}/ow_detail.png", (det[..., ::-1] * 255).astype(np.uint8))

# ---- painted tree atlas (4 cols x 2 rows, cell 512x1024)
CW, CH = 512, 1024
atlas = Image.new("RGBA", (CW*4, CH*2), (0, 0, 0, 0))
L = np.array([-0.6, 0.65, 0.45]); L /= np.linalg.norm(L)
def ramp(s, pal):
    s = np.clip(s, 0, 1) * (len(pal) - 1); i = int(min(s, len(pal) - 2)); f = s - i
    return tuple(int(255 * (pal[i][j] * (1 - f) + pal[i + 1][j] * f)) for j in range(3))
PAL_G = [(0.16, 0.20, 0.34), (0.20, 0.33, 0.30), (0.31, 0.47, 0.24), (0.55, 0.64, 0.28), (0.90, 0.84, 0.48)]
PAL_P = [(0.18, 0.22, 0.36), (0.22, 0.36, 0.28), (0.36, 0.52, 0.26), (0.64, 0.70, 0.32), (0.95, 0.88, 0.52)]
PAL_W = [(0.17, 0.24, 0.32), (0.24, 0.40, 0.33), (0.40, 0.58, 0.32), (0.66, 0.76, 0.40), (0.92, 0.90, 0.60)]
def stroke(d, x, y, ang, ln, wd, col, a=235):
    dx, dy = math.cos(ang) * ln / 2, math.sin(ang) * ln / 2
    d.line([(x - dx, y - dy), (x + dx, y + dy)], fill=col + (a,), width=max(1, int(wd)))
    d.ellipse([x - dx - wd/2, y - dy - wd/2, x - dx + wd/2, y - dy + wd/2], fill=col + (a,))
def paint_tree(kind, seed):
    r = np.random.default_rng(seed)
    img = Image.new("RGBA", (CW, CH), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    cx = CW / 2
    if kind == "poplar":
        top, bot, rw = 60, 900, 95; pal = PAL_P
        shape = lambda x, y: ((x - cx) / (rw * math.sin(math.pi * min(max((y - top) / (bot - top), 0), 1)) ** 0.7 + 1e-3)) ** 2
        trunk = (cx, 880, 1010, 10)
    elif kind == "round":
        pal = PAL_G; blobs = [(cx + r.normal(0, 60), 520 + r.normal(0, 70), 150 + r.normal(0, 25)) for _ in range(6)]
        shape = lambda x, y: min(((x - bx) ** 2 + (y - by) ** 2) / br ** 2 for bx, by, br in blobs)
        trunk = (cx, 700, 1010, 16); top, bot = 300, 760
    elif kind == "willow":
        pal = PAL_W; top, bot = 240, 980
        shape = lambda x, y: ((x - cx) / (205 * (0.25 + 0.75 * min(max((y - top) / 260, 0), 1) ** 0.5) + 1e-3)) ** 2 + (9 if y < top else 0)
        trunk = (cx, 700, 1010, 18)
    else:  # bush
        pal = PAL_G; blobs = [(cx + r.normal(0, 90), 860 + r.normal(0, 40), 120 + r.normal(0, 20)) for _ in range(5)]
        shape = lambda x, y: min(((x - bx) ** 2 + (y - by) ** 2) / br ** 2 for bx, by, br in blobs)
        trunk = None; top, bot = 650, 1000
    if trunk:
        x0, y0, y1, w = trunk
        for i in range(14):
            stroke(d, x0 + r.normal(0, w * 0.3), (y0 + y1) / 2 + r.normal(0, 30), math.pi / 2 + r.normal(0, 0.08), (y1 - y0) * 0.7, w * 0.5, (55, 45, 60))
    pts = []
    tries = 0
    while len(pts) < 2600 and tries < 60000:
        tries += 1
        x, y = r.uniform(0, CW), r.uniform(0, CH)
        s = shape(x, y)
        if s < 1.0: pts.append((x, y, s))
    pts.sort(key=lambda p: p[1])
    for x, y, s in pts:
        # fake normal: from centre of mass and edge proximity
        nx = (x - cx) / 200; ny = (1 - (y - top) / max(bot - top, 1)) * 0.9 - 0.35
        nz = math.sqrt(max(0.05, 1 - min(s, 1)))
        n = np.array([nx, ny + 0.2, nz]); n /= np.linalg.norm(n)
        sh = 0.38 + 0.62 * float(n @ L) + r.normal(0, 0.13)
        col = ramp(sh, pal)
        if kind == "poplar": ang = math.pi / 2 + r.normal(0, 0.35)
        elif kind == "willow": ang = math.pi / 2 + r.normal(0, 0.2) if y > top + 80 else r.uniform(0, math.pi)
        else: ang = r.uniform(0, math.pi)
        ln = r.uniform(14, 34) * (1.4 if kind == "willow" else 1.0); wd = r.uniform(5, 10)
        stroke(d, x, y, ang, ln, wd, col)
    return img
kinds = ["poplar", "poplar", "round", "round", "willow", "bush", "round", "poplar"]
for i, k in enumerate(kinds):
    atlas.paste(paint_tree(k, 100 + i), ((i % 4) * CW, (i // 4) * CH))
atlas.save(f"{OUT}/ow_trees.png")
small = atlas.resize((1024, 1024)); bg = Image.new("RGB", small.size, (200, 200, 210)); bg.paste(small, (0, 0), small); import os; os.makedirs("debug", exist_ok=True); bg.save("debug/ow_trees_preview.jpg")
print("ok")
