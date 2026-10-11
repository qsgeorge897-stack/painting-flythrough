"""Monet example - impasto "brushstroke planet" terrain from a crop of Water Lilies (1906).
Used by the original Monet cut (?cut=monet, 1:00-1:17). Needs img/lilies.jpg.
    python3 scripts/extras/prep_micro.py
"""
import json, numpy as np, cv2
OUT = "web/data"


def save_jpg(path, rgb, q=92):
    cv2.imwrite(path, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, q])


def prep_micro():
    img = cv2.cvtColor(cv2.imread("img/lilies.jpg"), cv2.COLOR_BGR2RGB)
    cx, cy, S = 1700, 2190, 1150
    crop = img[cy - S // 2: cy + S // 2, cx - S // 2: cx + S // 2]
    crop = cv2.resize(crop, (2048, 2048), interpolation=cv2.INTER_CUBIC)
    save_jpg(f"{OUT}/micro.jpg", crop, 93)
    lum = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    l1 = cv2.GaussianBlur(lum, (0, 0), 2.0)
    hp = l1 - cv2.GaussianBlur(l1, (0, 0), 10)
    lo = cv2.GaussianBlur(lum, (0, 0), 40)
    h = 0.75 * hp / (np.abs(hp).max() * 0.6) + 0.5 * (lo - lo.mean()) / (lo.std() * 4 + 1e-6)
    h = np.tanh(h * 1.3) * 0.5 + 0.5
    # normal map
    hs = cv2.GaussianBlur(h, (0, 0), 1.2)
    nx = cv2.Sobel(hs, cv2.CV_32F, 1, 0, ksize=3); ny = cv2.Sobel(hs, cv2.CV_32F, 0, 1, ksize=3)
    strength = 12.0
    n = np.stack([-nx * strength, ny * strength, np.ones_like(nx)], -1)   # y up in texture space flipped
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    nimg = ((n * 0.5 + 0.5) * 255).astype(np.uint8)
    cv2.imwrite(f"{OUT}/micro_n.png", cv2.cvtColor(nimg, cv2.COLOR_RGB2BGR))
    G = 641
    hg = cv2.resize(cv2.GaussianBlur(h, (0, 0), 2.5), (G, G), interpolation=cv2.INTER_AREA).astype(np.float32)
    hg.tofile(f"{OUT}/micro_h.bin")
    json.dump(dict(G=G), open(f"{OUT}/micro.json", "w"))
    print("micro done", h.min(), h.max())


if __name__ == "__main__":
    prep_micro()
