#!/bin/sh
# Records docs/demo/claude-code.gif: the terminal (claude-code.tape, VHS) and the admin
# UI (claude-code-browser.mjs, Playwright) at the same time, then joins them by the
# times the browser half writes — the terminal until the approvals scene, the
# approvals scene, the terminal from the approval until the journal scene, the
# journal scene. VHS writes frames at a steady 10 per second from the tape's first
# visible frame, which is how a time becomes a frame number.
#
# Usage, from the repository root, with Claude Code signed in:
#   PLAYWRIGHT_CORE=<…>/node_modules/playwright-core/index.mjs CHROME=<a Chromium executable> \
#     sh docs/demo/claude-code-render.sh
set -eu
: "${PLAYWRIGHT_CORE:?the path of index.mjs in playwright-core}"
: "${CHROME:?the path of a Chromium executable}"
DEMO=/tmp/mcpcut-demo
FRAMES=/tmp/mcpcut-demo-frames
JOIN=/tmp/mcpcut-demo-join
FPS=10
OUT=docs/demo/claude-code.gif

rm -rf "$DEMO" "$FRAMES" "$JOIN" && mkdir -p "$JOIN/seq"
# Playwright records video with its own ffmpeg, found under the real HOME, not the demo one.
PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright} \
  DEMO=$DEMO HOME=$DEMO/home MCPCUT_DATA_DIR=$DEMO/home/.mcpcut/data PATH="$DEMO/prefix/bin:$PATH" \
  node docs/demo/claude-code-browser.mjs &
BROWSER=$!
vhs docs/demo/claude-code.tape
wait "$BROWSER"

ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES/frame-text-%05d.png" -framerate "$FPS" -i "$FRAMES/frame-cursor-%05d.png" \
  -filter_complex "[0][1]overlay" "$JOIN/term-%05d.png"
for scene in video1 video2; do
  ffmpeg -y -loglevel error -i "$(ls "$DEMO/$scene"/*.webm | head -1)" -vf "fps=$FPS,scale=1220:666" "$JOIN/$scene-%05d.png"
done

node -e '
const { readFileSync, readdirSync, linkSync } = require("node:fs")
const [join, demo, fps] = process.argv.slice(1)
const t = JSON.parse(readFileSync(`${demo}/times.json`, "utf8"))
const frame = (ms) => Math.max(1, Math.round(((ms - t.t0) * Number(fps)) / 1000) + 1)
const named = (prefix) => readdirSync(join).filter((f) => f.startsWith(prefix)).sort()
const term = named("term-")
const range = (from, to) => term.slice(from - 1, Math.min(to, term.length))
const order = [...range(1, frame(t.rec1)), ...named("video1-"), ...range(frame(t.approve), frame(t.rec2)), ...named("video2-")]
order.forEach((f, i) => linkSync(`${join}/${f}`, `${join}/seq/${String(i + 1).padStart(5, "0")}.png`))
console.log(`${order.length} frames: terminal 1-${frame(t.rec1)}, approvals, terminal ${frame(t.approve)}-${frame(t.rec2)}, journal`)
' "$JOIN" "$DEMO" "$FPS"

ffmpeg -y -loglevel error -framerate "$FPS" -i "$JOIN/seq/%05d.png" \
  -filter_complex "split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none" "$OUT"
ls -l "$OUT"
