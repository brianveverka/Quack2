#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Build the ericw-tools map compilers (qbsp, vis, light, bspinfo) into .tools/.
# Idempotent: skips the build when the pinned commit's binaries already exist.
# Needs git, cmake, a C++20 compiler, and TBB + Embree 4 dev packages
# (Debian/Ubuntu: apt-get install libtbb-dev libembree-dev).
set -euo pipefail

ERICW_REPO=https://github.com/ericwa/ericw-tools.git
# Pinned so the committed fixture BSP can be reproduced byte for byte.
ERICW_COMMIT=36eec1da2a194467e6baac2f444c2dd04b57d266

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/.tools/ericw-tools"
bin="$root/.tools/bin"

if [[ -x "$bin/qbsp" && "$(cat "$bin/.commit" 2>/dev/null)" == "$ERICW_COMMIT" ]]; then
  echo "ericw-tools $ERICW_COMMIT already built in $bin"
  exit 0
fi

if [[ ! -d "$src/.git" ]]; then
  git clone --filter=blob:none "$ERICW_REPO" "$src"
fi
git -C "$src" fetch --depth 1 origin "$ERICW_COMMIT"
git -C "$src" checkout --quiet "$ERICW_COMMIT"
git -C "$src" submodule update --init --depth 1

cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
  -DSKIP_TBB_INSTALL=ON -DSKIP_EMBREE_INSTALL=ON -DDISABLE_TESTS=ON -DDISABLE_DOCS=ON
cmake --build "$src/build" --parallel --target qbsp vis light bspinfo

mkdir -p "$bin"
for t in qbsp vis light bspinfo; do cp "$src/build/$t/$t" "$bin/"; done
echo "$ERICW_COMMIT" > "$bin/.commit"
echo "built ericw-tools $ERICW_COMMIT into $bin"
