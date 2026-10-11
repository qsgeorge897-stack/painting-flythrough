#!/usr/bin/env bash
# One-click pipeline: Van Gogh "The Starry Night" fly-through (32 s, 1080p, 30 fps, silent)
#
#   pipelines/starry_night.sh            # everything
#   pipelines/starry_night.sh preview    # one stage: fetch | depth | prep | preview | render | caption | encode
#   W=960 H=540 pipelines/starry_night.sh render   # quick low-res render
#
# Rendering on a CPU-only Linux box (SwiftShader) takes ~3.5 s/frame at 1080p ≈ 1 h for 960 frames.
# On a desktop with a GPU add GPU=1 (much faster).
set -euo pipefail
cd "$(dirname "$0")/.."
STAGE=${1:-all}; W=${W:-1920}; H=${H:-1080}; FPS=30; DUR=32
GPUFLAG=$([ "${GPU:-0}" = "1" ] && echo --gpu || true)
run() { [ "$STAGE" = all ] || [ "$STAGE" = "$1" ]; }

if run fetch && [ ! -f img/starry_orig.jpg ]; then
  python3 scripts/fetch_wikimedia.py "File:Van Gogh - Starry Night - Google Art Project.jpg" starry --width 3840
fi
if run depth && [ ! -f depth/starry_orig.npy ]; then python3 scripts/depth.py starry; fi
if run prep; then python3 scripts/paintings/starry_night.py; fi
if run preview; then
  node web/render.js --cut starry --out frames/starry_preview --w 960 --h 540 --times 0.5,2.5,6.5,10,15,19,23.6,28 $GPUFLAG
  echo "preview stills in frames/starry_preview/ - look at them before the long render"
fi
if run render; then node web/render.js --cut starry --out frames/starry --range 0 $DUR --fps $FPS --w "$W" --h "$H" $GPUFLAG; fi
if run caption; then
  python3 scripts/caption.py frames/starry frames/starry_cap --fps $FPS --start 26.6 --end 31.5 \
    --line1 "文森特·梵高 ｜《星月夜》 1889年 ｜ 布面油画" \
    --line2 "现藏于纽约现代艺术博物馆（MoMA），73.7 cm × 92.1 cm"
fi
if run encode; then scripts/encode.sh frames/starry_cap out/starry_night_${H}p.mp4 $FPS 7000k; fi
