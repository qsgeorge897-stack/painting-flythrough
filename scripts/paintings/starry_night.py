"""Painting-specific prep for Van Gogh "The Starry Night" (run after fetch + depth).

    python3 scripts/paintings/starry_night.py

What it adds on top of the generic prep_world.py (this is the part you rewrite for a new painting):
  1. crop the unpainted canvas border
  2. fix the depth map by hand-made masks: sky = one smooth far shell, cypress = one near object,
     hills/village = middle distance  (monocular depth is noisy on paintings - masks make it read cleanly)
  3. light sources (stars, moon, lit windows) -> web/data/starry_lights.json  (glow sprites in the renderer)
  4. flow field of the brushstrokes -> web/data/starry_flow.png  (R,G = direction, B = strength)
     used to make the sky "flow" in 2D and to move the volumetric strokes in 3D
  5. generic prep_world() with a wide mirrored margin, then two fixes for the cypress:
     the background layer behind it is sky (depth + colour) and nothing outside the canvas is a mirrored cypress
Debug images go to debug/ - always look at them before rendering.
"""
import json, os, shutil, sys
import numpy as np, cv2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from prep_world import prep_world, depth_edges, OUT  # noqa: E402

K = "starry"
os.makedirs("debug", exist_ok=True)

# ---------------------------------------------------------------- 1. crop canvas border
if not os.path.exists(f"img/{K}_orig.jpg"):
    shutil.copy(f"img/{K}.jpg", f"img/{K}_orig.jpg")
    if os.path.exists(f"depth/{K}.npy"):
        shutil.copy(f"depth/{K}.npy", f"depth/{K}_orig.npy")
img = cv2.cvtColor(cv2.imread(f"img/{K}_orig.jpg"), cv2.COLOR_BGR2RGB)
H0, W0 = img.shape[:2]
s = W0 / 3840.0                                    # crop measured on the 3840 px Commons thumbnail
x0, y0, x1, y1 = int(48 * s), int(10 * s), W0 - int(40 * s), H0 - int(14 * s)
img = img[y0:y1, x0:x1]
H, W = img.shape[:2]
cv2.imwrite(f"img/{K}.jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])

# ---------------------------------------------------------------- 2. depth clean-up with masks
d = np.load(f"depth/{K}_orig.npy")
dh, dw = d.shape
d = d[int(y0 / H0 * dh):int(y1 / H0 * dh), int(x0 / W0 * dw):int(x1 / W0 * dw)]
d = cv2.resize(d, (1024, round(1024 * H / W)), interpolation=cv2.INTER_CUBIC)
h, w = d.shape
vv = np.linspace(0, 1, h)[:, None] * np.ones((1, w))
uu = np.ones((h, 1)) * np.linspace(0, 1, w)[None, :]
small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
# skyline (u, v) traced by eye along the hills
HILL = [(0, 0.71), (0.2, 0.71), (0.42, 0.69), (0.52, 0.655), (0.62, 0.625), (0.75, 0.6), (0.86, 0.56), (0.9, 0.52), (0.95, 0.505), (1.0, 0.51)]
hill = np.interp(uu[0], [p[0] for p in HILL], [p[1] for p in HILL])[None, :] * np.ones((h, 1))
cyp = ((d > 0.42) & (uu < 0.47)).astype(np.uint8)                 # cypress = biggest near blob on the left
n, lab, st, _ = cv2.connectedComponentsWithStats(cyp)
cyp = ((lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))) & ~((uu < 0.1) & (vv < 0.78))).astype(np.uint8)
cyp = cv2.dilate(cyp, np.ones((5, 5), np.uint8))
sky = ((vv < hill) & (cyp == 0)).astype(np.float32)
d = np.where((vv >= hill) & (cyp == 0), np.maximum(d, 0.16), d)    # land never further than the sky
sky_soft = cv2.GaussianBlur(sky, (0, 0), 4)
d = d * (1 - sky_soft) + (0.02 + 0.06 * vv) * sky_soft             # sky = smooth shell, slightly tilted
np.save(f"depth/{K}.npy", d.astype(np.float32))
cv2.imwrite(f"debug/{K}_depth.png", (np.clip(d, 0, 1) * 255).astype(np.uint8))

# ---------------------------------------------------------------- 3. light sources (u, v, radius in canvas units)
STARS = [(0.098, 0.042, 0.045), (0.225, 0.037, 0.02), (0.345, 0.036, 0.028), (0.407, 0.057, 0.022), (0.226, 0.172, 0.035),
         (0.613, 0.087, 0.04), (0.701, 0.228, 0.045), (0.319, 0.324, 0.03), (0.121, 0.479, 0.035), (0.037, 0.447, 0.025), (0.346, 0.527, 0.06)]
stars = [dict(u=u, v=v, r=r) for u, v, r in STARS]                  # placed by hand, centroids refined on bright yellow pixels
moon = dict(u=0.90, v=0.187, r=0.08)
f = small.astype(np.float32) / 255
lum = f @ np.array([0.3, 0.59, 0.11]); yel = (f[..., 0] + f[..., 1]) / 2 - f[..., 2]
win = ((yel > 0.22) & (lum > 0.45) & (vv > 0.66) & (uu > 0.38) & (d > 0.3)).astype(np.uint8)
n2, _, st2, ce2 = cv2.connectedComponentsWithStats(win)
windows = [dict(u=ce2[i][0] / w, v=ce2[i][1] / h, r=float(np.sqrt(st2[i, cv2.CC_STAT_AREA] / np.pi) / w))
           for i in range(1, n2) if 3 <= st2[i, cv2.CC_STAT_AREA] < 400]
json.dump(dict(stars=stars, moon=moon, windows=windows), open(f"{OUT}/{K}_lights.json", "w"))
print(f"lights: {len(stars)} stars, moon, {len(windows)} windows")

# ---------------------------------------------------------------- 4. flow field
g = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255, (0, 0), 1.2)
ix = cv2.Sobel(g, cv2.CV_32F, 1, 0); iy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
jxx = cv2.GaussianBlur(ix * ix, (0, 0), 9); jyy = cv2.GaussianBlur(iy * iy, (0, 0), 9); jxy = cv2.GaussianBlur(ix * iy, (0, 0), 9)
th = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2
tx, ty = np.cos(th), np.sin(th)          # stroke direction, but its sign (forward/backward) is ambiguous
asp = h / w


def vortex(cu, cv_, rad, sgn):
    dx, dy = uu - cu, (vv - cv_) * asp
    rr = np.sqrt(dx * dx + dy * dy) + 1e-4
    k = np.exp(-(rr / rad) ** 2)
    return sgn * (-dy / rr) * k, sgn * (dx / rr) * k


# designed reference flow: wind to the right + the two big swirls + small swirls around every light
rx = np.ones_like(uu) * 0.6; ry = np.zeros_like(uu)
for cu, cv_, rad, sgn in [(0.47, 0.36, 0.16, -1), (0.66, 0.45, 0.10, 1)]:
    a, b = vortex(cu, cv_, rad, sgn); rx += 1.6 * a; ry += 1.6 * b
for sl in stars + [moon]:
    a, b = vortex(sl["u"], sl["v"], sl["r"] * 1.6 + 0.01, 1); rx += a; ry += b
sgn = np.sign(tx * rx + ty * ry); sgn[sgn == 0] = 1                 # pick the stroke sign that agrees with it
fx, fy = tx * sgn, ty * sgn
blend = np.clip(np.sqrt(rx * rx + ry * ry), 0, 1) * 0.25
fx = cv2.GaussianBlur((fx * (1 - blend) + rx * blend).astype(np.float32), (0, 0), 3)
fy = cv2.GaussianBlur((fy * (1 - blend) + ry * blend).astype(np.float32), (0, 0), 3)
nrm = np.sqrt(fx * fx + fy * fy) + 1e-6; fx /= nrm; fy /= nrm
cs = cv2.GaussianBlur(cyp.astype(np.float32), (0, 0), 3)
hills = np.clip((1 - sky_soft) * (vv < 0.72) * (d < 0.42), 0, 1).astype(np.float32)
mag = np.clip(sky_soft + hills * 0.35, 0, 1) * (1 - cs)
fx = fx * (1 - cs); fy = fy * (1 - cs) - cs                       # cypress flickers upwards
mag = cv2.GaussianBlur(np.maximum(mag, cs * 0.35).astype(np.float32), (0, 0), 2)
flow = np.stack([fx * 0.5 + 0.5, fy * 0.5 + 0.5, mag], -1)
cv2.imwrite(f"{OUT}/{K}_flow.png", cv2.cvtColor((np.clip(flow, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
vis = small.copy() // 2
for yy in range(8, h, 16):
    for xx in range(8, w, 16):
        if mag[yy, xx] >= 0.2:
            cv2.arrowedLine(vis, (xx, yy), (int(xx + fx[yy, xx] * 10), int(yy + fy[yy, xx] * 10)), (255, 255, 255), 1, tipLength=0.4)
for sl in stars + [moon]:
    cv2.circle(vis, (int(sl["u"] * w), int(sl["v"] * h)), int(sl["r"] * w) + 2, (255, 220, 0), 1)
cv2.imwrite(f"debug/{K}_flow.jpg", cv2.cvtColor(vis, cv2.COLOR_RGB2BGR))

# ---------------------------------------------------------------- 5. generic mesh + strokes, then cypress fixes
meta = prep_world(K, grid=640, nstroke=70000, margin=0.45, tex_width=0, edge_dilate=True)
nx, ny, M = meta["GW"] + 1, meta["GH"] + 1, meta["margin"]
cfg = json.load(open(f"{OUT}/worlds.json"))[K]
geo = np.fromfile(f"{OUT}/{K}_geo.bin", np.float32).reshape(ny, nx, 3)
px, py = int(M * w), int(M * h)
pad = lambda a: cv2.copyMakeBorder(a, py, py, px, px, cv2.BORDER_REFLECT_101)
mk = cv2.dilate(cyp.astype(np.float32), np.ones((9, 9), np.uint8))
mg = cv2.resize(pad(cv2.GaussianBlur(mk, (0, 0), 3)), (nx, ny), interpolation=cv2.INTER_AREA)
dsky = cv2.resize(pad((0.02 + 0.06 * vv).astype(np.float32)), (nx, ny), interpolation=cv2.INTER_AREA)
geo[..., 2] = geo[..., 2] * (1 - mg) + dsky * mg                   # bg layer behind the cypress = sky shell
U, V = np.meshgrid(-M + (1 + 2 * M) * np.arange(nx) / (nx - 1), -M + (1 + 2 * M) * np.arange(ny) / (ny - 1))
out = np.clip(np.maximum.reduce([-U, U - 1, -V, V - 1]) / 0.03, 0, 1)
geo[..., 0] = geo[..., 0] * (1 - out) + geo[..., 2] * out          # outside the canvas: no mirrored cypress
geo[..., 1] = depth_edges(geo[..., 0], cfg["zn"], cfg["zf"], cfg["gamma"], dilate=True)
geo.astype(np.float32).tofile(f"{OUT}/{K}_geo.bin")
# bg colour behind the cypress: borrow the sky one third of a canvas to the right
bw = 1024; bh = round(bw * H / W)
sm = cv2.resize(cv2.cvtColor(img, cv2.COLOR_RGB2BGR), (bw, bh), interpolation=cv2.INTER_AREA).astype(np.float32)
mm = cv2.resize(mk, (bw, bh)) * (np.linspace(0, 1, bh)[:, None] < 0.66)
a = cv2.GaussianBlur(mm.astype(np.float32), (0, 0), 4)[..., None]
cv2.imwrite(f"{OUT}/{K}_bg.jpg", (sm * (1 - a) + np.roll(sm, -int(0.33 * bw), axis=1) * a).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
cv2.imwrite(f"debug/{K}_bg.jpg", cv2.imread(f"{OUT}/{K}_bg.jpg"))
print("starry night prep done - check debug/starry_*.{png,jpg}")
