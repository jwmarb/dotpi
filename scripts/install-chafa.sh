#!/usr/bin/env bash
#
# Build chafa (https://hpjansson.org/chafa/) from source into ~/.local.
#
#     bash scripts/install-chafa.sh [--force]
#
# startup-fetch.ts uses chafa for the finer character styles (quad, sextant,
# octant, braille, ascii). Optional: without it those styles fall back to
# catimg half-blocks. libchafa is linked in statically (--disable-shared, so
# no LD_LIBRARY_PATH); image loaders still link the system libjpeg/libwebp/...
# found at build time — rebuild (--force) if a distro upgrade drops one.
# Only the CLI is installed.
#
# Needs git, autoconf, automake, libtool, make, pkg-config, a C compiler and
# glib-2.0 headers; freetype is optional. No sudo. Idempotent unless --force.
set -euo pipefail

CHAFA_REPO="https://github.com/hpjansson/chafa.git"
CHAFA_REF="1.16.2"
PREFIX="${CHAFA_PREFIX:-$HOME/.local}"
STAMP="$PREFIX/share/chafa/.dotpi-ref"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ "$FORCE" -eq 0 ] && [ -x "$PREFIX/bin/chafa" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$CHAFA_REF" ]; then
	echo "chafa already built at $CHAFA_REF ($PREFIX/bin/chafa)"
	exit 0
fi

for cmd in git autoconf automake libtoolize make pkg-config; do
	command -v "$cmd" >/dev/null 2>&1 || { echo "chafa: $cmd is required to build from source" >&2; exit 1; }
done
if [ -z "${CC:-}" ] && ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
	echo "chafa: a C compiler (cc, gcc or clang) is required" >&2
	exit 1
fi
pkg-config --exists glib-2.0 || { echo "chafa: glib-2.0 development files are required (libglib2.0-dev / glib2-devel)" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -c advice.detachedHead=false clone -q --depth 1 --branch "$CHAFA_REF" "$CHAFA_REPO" "$work/src"
cd "$work/src"
log="$work/build.log"
{
	NOCONFIGURE=1 ./autogen.sh
	./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-man --disable-gtk-doc
	make -j"$(nproc 2>/dev/null || echo 2)"
} >"$log" 2>&1 || { tail -20 "$log" >&2; exit 1; }
install -Dm755 tools/chafa/chafa "$PREFIX/bin/chafa"

mkdir -p "$(dirname "$STAMP")"
printf '%s\n' "$CHAFA_REF" >"$STAMP"
loaders=$("$PREFIX/bin/chafa" --version | sed -n 's/^ *Loaders: *//p')
for fmt in JPEG PNG; do
	case " $loaders " in *" $fmt "*) ;; *) echo "chafa: built without a $fmt loader (install its -dev package and rerun with --force)" >&2 ;; esac
done
echo "chafa built at $CHAFA_REF -> $PREFIX/bin/chafa (loaders: ${loaders:-unknown})"
