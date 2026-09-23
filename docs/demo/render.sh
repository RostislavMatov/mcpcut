#!/bin/sh
# Records docs/demo/quickstart.gif from docs/demo/quickstart.tape.
# VHS writes the frames (text and cursor as two layers); ffmpeg joins them.
# The join is ours because VHS 0.12's own join writes no GIF with ffmpeg 9
# and says nothing about it.
#
# Usage, from the repository root:  sh docs/demo/render.sh
set -eu
FRAMES=/tmp/mcpcut-demo-frames
FPS=10
rm -rf "$FRAMES"
vhs docs/demo/quickstart.tape
ffmpeg -y -loglevel error \
  -framerate "$FPS" -i "$FRAMES/frame-text-%05d.png" \
  -framerate "$FPS" -i "$FRAMES/frame-cursor-%05d.png" \
  -filter_complex "[0][1]overlay,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" \
  docs/demo/quickstart.gif
ls -l docs/demo/quickstart.gif
