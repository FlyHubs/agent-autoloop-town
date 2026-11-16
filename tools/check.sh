#!/bin/bash
# Checks the page's script the way a browser reads it: as a module. `node --check diorama.js` reads it as a plain
# script and lets through mistakes a browser stops at.
here="$(cd "$(dirname "$0")/.." && pwd)"
copy="$(mktemp -t diorama-check).mjs"
cp "$here/diorama.js" "$copy" && node --check "$copy" && echo "diorama.js: syntax ok (as a module)"
status=$?
rm -f "$copy"
exit $status
