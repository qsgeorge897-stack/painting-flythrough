"""Step 1 - download a public-domain painting from Wikimedia Commons.

    python3 scripts/fetch_wikimedia.py "File:Van Gogh - Starry Night - Google Art Project.jpg" starry
    python3 scripts/fetch_wikimedia.py "<Commons file title>" <name> --width 3840

Saves img/<name>.jpg (longest side ~= --width). Wikimedia rate-limits aggressively (HTTP 429):
the script waits and retries. Please put your own contact in --contact (Wikimedia's User-Agent policy).
"""
import argparse, json, os, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("title", help='Commons file title, e.g. "File:Van Gogh - Starry Night - Google Art Project.jpg"')
ap.add_argument("name", help="short name used everywhere else (img/<name>.jpg, web/data/<name>_*)")
ap.add_argument("--width", type=int, default=3840, help="target width in px (Commons thumbnail service)")
ap.add_argument("--contact", default="painting-flythrough (github)", help="contact string for the User-Agent")
a = ap.parse_args()
UA = {"User-Agent": f"PaintingFlythrough/1.0 ({a.contact})"}


def get(url, binary=False, tries=8):
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()
            return r if binary else json.loads(r)
        except Exception as e:  # 429 / transient network errors
            wait = 10 + 10 * i
            print(f"  retry in {wait}s ({e})")
            time.sleep(wait)
    raise SystemExit("download failed: " + url)


q = urllib.parse.urlencode({"action": "query", "titles": a.title, "prop": "imageinfo",
                            "iiprop": "url|size|extmetadata", "iiurlwidth": a.width, "format": "json"})
d = get("https://commons.wikimedia.org/w/api.php?" + q)
page = next(iter(d["query"]["pages"].values()))
if "imageinfo" not in page:
    raise SystemExit(f"not found on Commons: {a.title}  (search https://commons.wikimedia.org first)")
ii = page["imageinfo"][0]
meta = ii.get("extmetadata", {})
lic = meta.get("LicenseShortName", {}).get("value", "?")
print(f"{a.title}\n  original {ii['width']}x{ii['height']}  license: {lic}")
if "public domain" not in lic.lower() and "pd" not in lic.lower() and "cc0" not in lic.lower():
    print("  WARNING: this file does not look public-domain - check the license before publishing!")
url = ii["thumburl"] if ii["width"] > a.width and ii.get("thumburl") else ii["url"]
os.makedirs("img", exist_ok=True)
data = get(url, binary=True)
open(f"img/{a.name}.jpg", "wb").write(data)
print(f"  saved img/{a.name}.jpg ({len(data) / 1e6:.1f} MB)")
