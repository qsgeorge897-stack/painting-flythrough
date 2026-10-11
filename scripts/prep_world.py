"""Step 3 - turn painting + depth into renderer data for one "PaintWorld".

    python3 scripts/prep_world.py allee
    python3 scripts/prep_world.py starry --grid 640 --strokes 70000 --margin 0.45 --tex-width 0

Needs: img/<name>.jpg, depth/<name>.npy, an entry "<name>" in web/data/worlds.json
Writes web/data/:
  <name>.jpg          painting texture
  <name>_bg.jpg       background-layer colour (painting blurred where foreground objects were)
  <name>_geo.bin      float32 grid (GH+1, GW+1, 3): [fg disparity, depth-edge strength, bg disparity]
  <name>_strokes.bin  float32 (N, 12) brush strokes: u, v, disparity, angle, r, g, b, length, rnd, rnd2, 0, 0
  <name>.json         meta (size, grid, margin, stroke count, aspect)

How the depth mesh works (see docs/WORKFLOW.md, "深度渲染原理"):
  * disparity d (0 far .. 1 near) -> distance z = zn * (zf/zn) ** ((1-d) ** gamma)
  * every vertex is put on the camera ray through its pixel, so from the "home" camera the
    3D scene projects back to exactly the original painting (2D <-> 3D without a cut)
  * fg mesh triangles that straddle a depth jump are discarded in the shader (edge > worlds.json "edge")
    and the bg mesh (smooth far envelope) shows through the hole instead of stretched smears
"""
import argparse, json, os
import numpy as np, cv2

OUT = "web/data"


def save_jpg(path, rgb, q=92):
    cv2.imwrite(path, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, q])


def depth_to_log(d, zn, zf, p):
    return np.log(zn) + np.log(zf / zn) * np.power(1 - np.clip(d, 0, 1), p)


def prep_world(k, grid=420, nstroke=30000, margin=0.22, tex_width=3000, edge_dilate=False, seed=7):
    rng = np.random.default_rng(seed)
    os.makedirs(OUT, exist_ok=True)
    cfg = json.load(open(f"{OUT}/worlds.json"))
    if k not in cfg:
        raise SystemExit(f'add an entry "{k}" to {OUT}/worlds.json first (copy "starry" and adjust)')
    C = cfg[k]; zn, zf, p = C["zn"], C["zf"], C["gamma"]

    img = cv2.cvtColor(cv2.imread(f"img/{k}.jpg"), cv2.COLOR_BGR2RGB)
    H, W = img.shape[:2]
    if tex_width and W > tex_width:
        img = cv2.resize(img, (tex_width, round(tex_width * H / W)), interpolation=cv2.INTER_AREA); H, W = img.shape[:2]
    save_jpg(f"{OUT}/{k}.jpg", img, 93)

    d = np.load(f"depth/{k}.npy").astype(np.float32)
    d = cv2.resize(d, (1024, round(1024 * H / W)), interpolation=cv2.INTER_CUBIC)
    d = cv2.bilateralFilter(d, 9, 0.08, 6)
    d = cv2.bilateralFilter(d, 9, 0.06, 4)
    h0, w0 = d.shape
    L = depth_to_log(d, zn, zf, p)
    # background surface = smooth far envelope (never has discontinuities)
    Lenv = cv2.dilate(L, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    Lenv = cv2.GaussianBlur(Lenv, (0, 0), 18)
    Lbg = np.maximum(Lenv, L)
    Lbg = np.maximum(cv2.GaussianBlur(Lbg, (0, 0), 4), L)
    mask = ((Lbg - L) > 0.2).astype(np.uint8)
    t = np.clip((Lbg - np.log(zn)) / np.log(zf / zn), 0, 1)
    bgd = (1 - np.power(t, 1 / p)).astype(np.float32)
    small = cv2.resize(img, (w0, h0), interpolation=cv2.INTER_AREA)
    m2 = cv2.dilate(mask * 255, np.ones((5, 5), np.uint8))
    soft = cv2.GaussianBlur(m2.astype(np.float32) / 255, (0, 0), 6)[..., None]
    blurred = cv2.GaussianBlur(small, (0, 0), 14).astype(np.float32)
    bgc = (small.astype(np.float32) * (1 - soft) + blurred * soft).clip(0, 255).astype(np.uint8)
    save_jpg(f"{OUT}/{k}_bg.jpg", bgc, 88)

    # mesh grid over [-margin, 1+margin] (mirrored outside the canvas so camera moves never see a border)
    GH = round(grid * H / W)
    px, py = int(margin * w0), int(margin * h0)
    pad = lambda a: cv2.copyMakeBorder(a, py, py, px, px, cv2.BORDER_REFLECT_101)
    nx, ny = grid + 1, GH + 1
    dg = cv2.resize(pad(d), (nx, ny), interpolation=cv2.INTER_AREA)
    bg = cv2.resize(pad(bgd), (nx, ny), interpolation=cv2.INTER_AREA)
    e = depth_edges(dg, zn, zf, p, edge_dilate)
    np.stack([dg, e, bg], -1).astype(np.float32).tofile(f"{OUT}/{k}_geo.bin")
    print(f"{k}: bg-hole fraction {mask.mean():.3f}, depth-edge fraction {(e > C.get('edge', 0.25)).mean():.3f}")

    # brush strokes: sampled where the painting has structure, oriented along its iso-lines
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    g = cv2.GaussianBlur(gray, (0, 0), 1.5)
    ix = cv2.Sobel(g, cv2.CV_32F, 1, 0); iy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
    jxx = cv2.GaussianBlur(ix * ix, (0, 0), 5); jyy = cv2.GaussianBlur(iy * iy, (0, 0), 5); jxy = cv2.GaussianBlur(ix * iy, (0, 0), 5)
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2
    mag = cv2.GaussianBlur(np.sqrt(ix * ix + iy * iy), (0, 0), 3); mag /= mag.max()
    prob = (0.35 + mag).ravel(); prob /= prob.sum()
    idx = rng.choice(h0 * w0, nstroke, p=prob)
    yy, xx = np.divmod(idx, w0)
    u = (xx + rng.random(nstroke)) / w0; v = (yy + rng.random(nstroke)) / h0
    colb = cv2.GaussianBlur(small, (0, 0), 1.2).astype(np.float32) / 255
    col = colb[yy, xx] * (0.94 + 0.12 * rng.random((nstroke, 1)))
    ang = theta[yy, xx] + rng.normal(0, 0.25, nstroke)
    length = (6 + 16 * rng.random(nstroke) ** 1.5) / w0
    st = np.stack([u, v, d[yy, xx], ang, col[:, 0], col[:, 1], col[:, 2], length, rng.random(nstroke),
                   rng.random(nstroke), np.zeros(nstroke), np.zeros(nstroke)], -1).astype(np.float32)
    st = st[np.argsort(st[:, 2])]          # far -> near, so alpha blending is right from the home view
    st.tofile(f"{OUT}/{k}_strokes.bin")
    meta = dict(W=W, H=H, GW=grid, GH=GH, margin=margin, nstroke=nstroke, aspect=H / W)
    json.dump(meta, open(f"{OUT}/{k}.json", "w"))
    print(f"{k}: {meta}")
    return meta


def depth_edges(dg, zn, zf, p, dilate=False):
    """local log-depth range over a 3x3 neighbourhood - large values = silhouette edges.
    dilate=True widens the cut by one cell (use for big near objects such as the cypress in Starry Night)"""
    Lg = depth_to_log(dg, zn, zf, p)
    k3 = np.ones((3, 3), np.uint8)
    e = cv2.dilate(Lg, k3) - cv2.erode(Lg, k3)
    return cv2.dilate(e, k3) if dilate else e


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--grid", type=int, default=420, help="mesh columns (rows follow the aspect ratio)")
    ap.add_argument("--strokes", type=int, default=30000)
    ap.add_argument("--margin", type=float, default=0.22, help="mirrored extension beyond the canvas, in canvas widths")
    ap.add_argument("--tex-width", type=int, default=3000, help="max texture width, 0 = keep original")
    ap.add_argument("--edge-dilate", action="store_true", help="widen silhouette cuts by one grid cell")
    a = ap.parse_args()
    for k in a.names:
        prep_world(k, a.grid, a.strokes, a.margin, a.tex_width, a.edge_dilate)
