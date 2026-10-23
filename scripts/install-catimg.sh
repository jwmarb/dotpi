#!/usr/bin/env bash
#
# Build catimg (https://github.com/posva/catimg) from source into ~/.local.
#
#     bash scripts/install-catimg.sh [--force]
#
# startup-fetch.ts renders the startup-panel image through catimg. It is
# optional: without it the panel falls back to the ASCII distro logo.
#
# Pinned to a commit, not the v2.8.0 tag: that tag no longer compiles on
# current gcc (implicit `usleep` declaration is an error since gcc 14).
# Bump CATIMG_REF deliberately, after building it once.
#
# Needs git, cmake, make and a C compiler; no sudo (installs to ~/.local/bin).
# Idempotent: skips the build when the installed binary already reports this
# ref, unless --force. Exit 0 on success or already-installed, 1 on failure.
set -euo pipefail

CATIMG_REPO="https://github.com/posva/catimg.git"
CATIMG_REF="3531972cb5b166a8ced06109e622e14748fadbe4"
PREFIX="${CATIMG_PREFIX:-$HOME/.local}"
STAMP="$PREFIX/share/catimg/.dotpi-ref"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ "$FORCE" -eq 0 ] && [ -x "$PREFIX/bin/catimg" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$CATIMG_REF" ]; then
	echo "catimg already built at ${CATIMG_REF:0:7} ($PREFIX/bin/catimg)"
	exit 0
fi

for cmd in git cmake make; do
	command -v "$cmd" >/dev/null 2>&1 || { echo "catimg: $cmd is required to build from source" >&2; exit 1; }
done
# cmake honours $CC, else finds its own; check that something is there.
if [ -z "${CC:-}" ] && ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
	echo "catimg: a C compiler (cc, gcc or clang) is required" >&2
	exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git init -q "$work/src"
git -C "$work/src" fetch -q --depth 1 "$CATIMG_REPO" "$CATIMG_REF"
git -C "$work/src" checkout -q FETCH_HEAD

cmake -S "$work/src" -B "$work/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" >/dev/null
cmake --build "$work/build" -j >/dev/null 2>"$work/build.log" || { cat "$work/build.log" >&2; exit 1; }
cmake --install "$work/build" >/dev/null

mkdir -p "$(dirname "$STAMP")"
printf '%s\n' "$CATIMG_REF" >"$STAMP"
echo "catimg built at ${CATIMG_REF:0:7} -> $PREFIX/bin/catimg"
