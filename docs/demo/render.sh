#!/bin/sh
# Records docs/demo/<name>.gif from docs/demo/<name>.tape (default: quickstart).
# VHS writes the frames (text and cursor as two layers); ffmpeg joins them.
# The join is ours because VHS 0.12's own join writes no GIF with ffmpeg 9
# and says nothing about it.
#
# Usage, from the repository root:
#   sh docs/demo/render.sh            # quickstart.tape -> quickstart.gif
#   sh docs/demo/render.sh console    # console.tape    -> console.gif
#   claude-code.gif has its own script, with a browser half: docs/demo/claude-code-render.sh
set -eu
NAME=${1:-quickstart}
FRAMES=/tmp/mcpcut-demo-frames
FPS=10
rm -rf "$FRAMES"
vhs "docs/demo/$NAME.tape"
ffmpeg -y -loglevel error \
  -framerate "$FPS" -i "$FRAMES/frame-text-%05d.png" \
  -framerate "$FPS" -i "$FRAMES/frame-cursor-%05d.png" \
  -filter_complex "[0][1]overlay,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" \
  "docs/demo/$NAME.gif"
ls -l "docs/demo/$NAME.gif"
