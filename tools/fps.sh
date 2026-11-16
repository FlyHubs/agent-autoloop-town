#!/bin/bash
# Opens the town headless, runs a snippet, and prints the frame rate averaged over two seconds.
# Usage: town/tools/fps.sh <port or full url> <label> <js to run after load>
here="$(cd "$(dirname "$0")" && pwd)"
target="$1"
label="$2"
after="$3"
case "$target" in
  http*) url="$target" ;;
  *) url="http://127.0.0.1:$target/" ;;
esac
scratch="${TMPDIR:-/tmp}/town-fps-scratch.png"
FLAGS="--use-angle=metal --enable-gpu --ignore-gpu-blocklist" PROBE='"x"' AFTER="$after" AFTER_WAIT=2 PROBE2='window.TOWN.frames().then((fps) => JSON.stringify({ fps, pace: window.TOWN.pace().level, fine: window.TOWN.models().filter((name) => name.startsWith("fine_")).length }))' node "$here/shot.mjs" "$url" "$scratch" 6 1680 1000 2>&1 | grep probe2 | sed "s/^probe2:/$label/"
