"""Optional - speed ramp: keep the key moments at normal speed, speed up the in-between parts.

    python3 scripts/retime.py frames/film frames/film_fast --fps 24 \
        --segments "0:7:2.0,7:18:1.1,18:38:2.0,38:58:1.5,58:200:1.3"

segments = start:end:speed (seconds of the ORIGINAL timeline). Speed changes are smoothed over
--smooth seconds so there is no visible jump; in-between frames are cross-blended.
Prints where your old timestamps land in the new timeline (useful for cutting to music).
"""
import argparse, os
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--fps", type=float, default=30)
ap.add_argument("--segments", required=True)
ap.add_argument("--smooth", type=float, default=1.5)
ap.add_argument("--marks", default="", help="comma list of original timestamps to report, e.g. 18,38,59.3")
a = ap.parse_args()

files = sorted(f for f in os.listdir(a.src) if f.endswith(".jpg"))
N = len(files); dur = (N - 1) / a.fps
segs = [tuple(map(float, s.split(":"))) for s in a.segments.split(",")]
grid = np.arange(0, dur + 1 / a.fps, 1 / a.fps)
sp = np.array([next((v for s, e, v in segs if s <= t < e), 1.0) for t in grid])
k = max(1, int(a.smooth * a.fps))
sp = np.convolve(np.pad(sp, (k // 2, k // 2), mode="edge"), np.ones(k) / k, mode="valid")[:len(grid)]
src, s = [], 0.0
while s <= dur:
    src.append(s); s += np.interp(s, grid, sp) / a.fps
src = np.array(src)
print(f"{N} frames ({dur:.1f}s) -> {len(src)} frames ({len(src) / a.fps:.1f}s)")
for m in [float(x) for x in a.marks.split(",") if x]:
    print(f"  {m:6.1f}s  ->  {np.searchsorted(src, m) / a.fps:6.1f}s")
os.makedirs(a.dst, exist_ok=True)
cache = {}
def load(i):
    i = min(i, N - 1)
    if i not in cache:
        if len(cache) > 6: cache.pop(next(iter(cache)))
        cache[i] = np.asarray(Image.open(os.path.join(a.src, files[i]))).astype(np.float32)
    return cache[i]
for j, t in enumerate(src):
    f = t * a.fps; i0 = int(f); w = f - i0
    img = load(i0) if w < 0.02 else load(i0) * (1 - w) + load(i0 + 1) * w
    Image.fromarray(np.clip(img + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(a.dst, f"{j:05d}.jpg"), quality=96)
print("done ->", a.dst)
