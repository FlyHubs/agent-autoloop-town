#!/bin/bash
# Opens the town headless, runs a snippet in the page, waits, prints what a second snippet returns plus anything the
# page logged, and saves a screenshot.
# Usage: town/tools/snap.sh <png> <js to run after load> [js to report] [url]
here="$(cd "$(dirname "$0")" && pwd)"
png="$1"
after="$2"
report="$3"
url="$4"
if [ -z "$report" ]; then report='JSON.stringify({ errors: window.TOWN.errors, drawn: window.TOWN.drawn(), pace: window.TOWN.pace().level })'; fi
if [ -z "$url" ]; then url='http://127.0.0.1:3401/'; fi
FLAGS="--use-angle=metal --enable-gpu --ignore-gpu-blocklist" PROBE='"x"' AFTER="$after" AFTER_WAIT=4 PROBE2="$report" node "$here/shot.mjs" "$url" "$png" 7 1680 1000 2>&1 | grep -v "^probe: " | cut -c1-3600 | head -40
