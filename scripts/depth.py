"""Step 2 - monocular depth estimation with Depth Anything V2 (runs on CPU, ~5-30 s per painting).

    python3 scripts/depth.py starry
    python3 scripts/depth.py bridge allee --model depth-anything/Depth-Anything-V2-Small-hf

Reads img/<name>.jpg, writes depth/<name>.npy (float32, 0 = far, 1 = near, i.e. relative disparity)
and depth/<name>_vis.png for a quick look.

Model licence: Depth-Anything-V2-Small is Apache-2.0; Base/Large are CC-BY-NC-4.0 (non-commercial).
Base gives cleaner silhouettes on paintings; use Small if the video is commercial.
"""
import argparse, time
import numpy as np, torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

ap = argparse.ArgumentParser()
ap.add_argument("names", nargs="+")
ap.add_argument("--model", default="depth-anything/Depth-Anything-V2-Base-hf")
ap.add_argument("--size", type=int, default=812, help="longest side fed to the model (multiple of 14)")
a = ap.parse_args()
torch.set_num_threads(max(1, torch.get_num_threads()))
proc = AutoImageProcessor.from_pretrained(a.model)
model = AutoModelForDepthEstimation.from_pretrained(a.model).eval()
import os; os.makedirs("depth", exist_ok=True)
for k in a.names:
    t = time.time()
    im = Image.open(f"img/{k}.jpg").convert("RGB")
    W, H = im.size
    s = a.size / max(W, H)
    small = im.resize((int(W * s) // 14 * 14, int(H * s) // 14 * 14), Image.LANCZOS)
    inp = proc(images=small, return_tensors="pt", do_resize=False)
    with torch.no_grad():
        out = model(**inp).predicted_depth
    d = out[0].numpy().astype(np.float32)
    d = (d - d.min()) / (d.max() - d.min() + 1e-6)
    np.save(f"depth/{k}.npy", d)
    Image.fromarray((d * 255).astype(np.uint8)).resize((W // 4, H // 4)).save(f"depth/{k}_vis.png")
    print(f"{k}: depth {d.shape} in {time.time() - t:.1f}s -> depth/{k}.npy")
