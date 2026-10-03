#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Compile fixtures/maps/<name>.map to .bsp with ericw-tools, then regenerate the
# golden JSON the tests compare against (from ericw-tools' own bspinfo dump).
# Usage: scripts/build-fixture.sh [name]   (default: test_arena)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-test_arena}
bin="$root/.tools/bin"
# Always routed through the pinned-commit check; a no-op when already built.
"$root/scripts/build-ericw-tools.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root/fixtures/maps/$name.map" "$work/"
cd "$work"

# Missing textures are expected (no game data in the repo); qbsp warns and continues.
"$bin/qbsp" -q2bsp "$name.map" > qbsp.log
# qbsp exits 0 on a leak; the pointfile is the signal.
if [[ -e "$name.pts" ]]; then echo "$name.map leaks, see qbsp output:" >&2; cat qbsp.log >&2; exit 1; fi
"$bin/vis" "$name.bsp" > vis.log
# Multithreaded light allocates lightmap offsets in nondeterministic order;
# one thread keeps rebuilds byte-identical.
"$bin/light" -threads 1 "$name.bsp" > light.log
"$bin/bspinfo" "$name.bsp" > bspinfo.log

node "$root/scripts/make-golden.mjs" "$name.bsp.json" "$name.bsp" > golden.json
# Only touch fixtures/ once every step has succeeded.
cp "$name.bsp" "$root/fixtures/maps/$name.bsp"
cp golden.json "$root/fixtures/maps/$name.golden.json"
echo "wrote fixtures/maps/$name.bsp and $name.golden.json"
