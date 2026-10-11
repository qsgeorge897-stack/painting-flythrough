#!/usr/bin/env bash
# Prepare all assets for the Monet cuts kept in web/film.js as examples:
#   ?cut=fusion2 (gallery-frame opening, 38.5 s) · fusion (30 s) · short (28 s) · open (34 s) · monet (original 2 min)
#
#   pipelines/monet_assets.sh
#   node web/render.js --cut fusion2 --out frames/fusion2 --range 0 38.5 --fps 30
set -euo pipefail
cd "$(dirname "$0")/.."
declare -A T=(
  [bridge]="File:Claude Monet - Water Lily Pond - 1933.441 - Art Institute of Chicago.jpg"
  [lilies]="File:Claude Monet - Water Lilies - 1933.1157 - Art Institute of Chicago.jpg"
  [irises]="File:Monet - Irises, 1914-17, 1956.1202.jpg"
  [poppy]="File:Claude Monet - Poppy Field - Google Art Project.jpg"
  [allee]="File:Monet - Eine Allee in Monets Garten in Giverny, 1902.jpg"
  [magpie]="File:Claude Monet - The Magpie - Google Art Project.jpg"
)
for k in bridge lilies irises poppy allee magpie; do
  [ -f "img/$k.jpg" ] || { python3 scripts/fetch_wikimedia.py "${T[$k]}" "$k" --width 3840; sleep 5; }
done
python3 scripts/depth.py bridge irises poppy allee magpie
python3 scripts/prep_world.py bridge irises poppy allee magpie
python3 scripts/extras/prep_micro.py
python3 scripts/extras/prep_pond.py
python3 scripts/extras/prep_openworld.py
echo "Monet assets ready in web/data/"
