"""Put rendered stills side by side with their file names - the fastest way to review a cut.

    python3 scripts/contact_sheet.py frames/check sheet.jpg            # every JPG in the folder
    python3 scripts/contact_sheet.py frames/check sheet.jpg --cols 4 --width 480
"""
import argparse, os
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("folder"); ap.add_argument("out")
ap.add_argument("--cols", type=int, default=3); ap.add_argument("--width", type=int, default=480)
a = ap.parse_args()


def key(f):  # t6_5.jpg -> 6.5 ; 00042.jpg -> 42
    s = f[:-4].lstrip("t").replace("_", ".")
    try: return float(s)
    except ValueError: return 1e9


files = sorted((f for f in os.listdir(a.folder) if f.endswith(".jpg")), key=key)
ims = [Image.open(os.path.join(a.folder, f)) for f in files]
w = a.width; h = round(w * ims[0].height / ims[0].width); rows = (len(ims) + a.cols - 1) // a.cols
S = Image.new("RGB", (a.cols * w + (a.cols - 1) * 6, rows * h + (rows - 1) * 6), "white")
for i, (f, im) in enumerate(zip(files, ims)):
    im = im.resize((w, h)); ImageDraw.Draw(im).text((6, 4), f, fill=(255, 255, 0))
    S.paste(im, ((i % a.cols) * (w + 6), (i // a.cols) * (h + 6)))
S.save(a.out, quality=90)
print(f"{len(files)} frames -> {a.out}")
