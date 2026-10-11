#!/usr/bin/env bash
# Step 6 - frames -> MP4 (H.264, yuv420p, faststart: plays everywhere, Douyin/剪映 friendly)
#
#   scripts/encode.sh frames/starry_cap out/starry.mp4            # 30 fps, ~7 Mbps (≈27 MB per 30 s)
#   scripts/encode.sh frames/starry_cap out/starry.mp4 24 12000k  # fps, max bitrate
#
# Size guide: Douyin re-encodes anyway, 8-12 Mbps 1080p is plenty. For sending in a chat with a
# 30 MB limit keep  bitrate(kbps) * seconds / 8 / 1024  under ~28 MB.
set -euo pipefail
SRC=${1:?frame folder}; OUT=${2:?output.mp4}; FPS=${3:-30}; MAXRATE=${4:-7000k}
mkdir -p "$(dirname "$OUT")"
ffmpeg -y -loglevel error -framerate "$FPS" -i "$SRC/%05d.jpg" \
  -c:v libx264 -preset slow -crf 20 -maxrate "$MAXRATE" -bufsize "$((${MAXRATE%k} * 2))k" \
  -pix_fmt yuv420p -profile:v high -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -movflags +faststart "$OUT"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
