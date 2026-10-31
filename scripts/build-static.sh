#!/usr/bin/env bash
# Static-link the DuckDB SQLite-ABI shim into ONE self-contained shared library
# per platform. No rpath, no libduckdb.dylib alongside — a single file.
#
# Fetches DuckDB's official `duckdb-static-libs-*` release archive for (os, arch)
# and links it into prebuilt/<platform>-<arch>.<ext>.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${SHIM_DUCKDB_VERSION:-v2.0.0}"
WORK="${WORK:-$(mktemp -d)}"
OUTDIR="${OUTDIR:-prebuilt}"
mkdir -p "$OUTDIR"

# ---- map (os, arch) -> static asset + output triple ----
# SHIM_TRIPLE overrides the host, so CI can cross-compile (e.g. darwin-x64
# built on an arm64 mac runner via `clang -arch x86_64`).
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)   HOST="darwin-arm64" ;;
  Darwin/x86_64)  HOST="darwin-x64" ;;
  Linux/x86_64)   HOST="linux-x64" ;;
  Linux/aarch64|Linux/arm64) HOST="linux-arm64" ;;
  *) echo "ERROR: no static asset for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
TRIPLE="${SHIM_TRIPLE:-$HOST}"
case "$TRIPLE" in
  darwin-arm64) ASSET=osx-arm64;   EXT=dylib; ARCH=arm64 ;;
  darwin-x64)   ASSET=osx-amd64;   EXT=dylib; ARCH=x86_64 ;;
  linux-x64)    ASSET=linux-amd64; EXT=so ;;
  linux-arm64)  ASSET=linux-arm64; EXT=so ;;
  *) echo "ERROR: unknown SHIM_TRIPLE=$TRIPLE" >&2; exit 1 ;;
esac

LIBS="$WORK/libs-$ASSET"
if [ ! -f "$LIBS/libduckdb_static.a" ]; then
  echo ">> fetching duckdb-static-libs-$ASSET ($VER)"
  mkdir -p "$LIBS"
  curl -fsSL "https://github.com/duckdb/duckdb/releases/download/$VER/duckdb-static-libs-$ASSET.tar.gz" | tar xz -C "$LIBS"
fi
# main archive first (single-pass linkers), the CLI shell left out
ARCHIVES="$LIBS/libduckdb_static.a $(ls "$LIBS"/*.a | grep -v -e libduckdb_static.a -e libduckdb_shell.a)"

OUT="$OUTDIR/${TRIPLE}.${EXT}"
echo ">> linking -> $OUT"

# Export ONLY the sqlite3_* ABI. Statically linked DuckDB is C++ with thousands of
# weak/vague-linkage symbols (typeinfo, vtables, inline statics); exported, they get
# coalesced by the dynamic loader with a second DuckDB in the process (e.g.
# @duckdb/node-api) and each copy ends up running the other's objects -> segfault.
EXPORTS="$WORK/exports.txt"
if [ "$EXT" = "dylib" ]; then
  echo "_sqlite3_*" > "$EXPORTS"
  cc -arch "$ARCH" -shared -O2 -fPIC -Wall -DDUCKDB_STATIC_BUILD -I"$LIBS" \
     -o "$OUT" shim/duckdb_sqlite_shim.c $ARCHIVES \
     -lc++ -framework CoreFoundation -framework Security \
     -Wl,-install_name,@rpath/duckdb-bun-shim.dylib \
     -Wl,-exported_symbols_list,"$EXPORTS" \
     -Wl,-dead_strip
else
  printf '{ global: sqlite3_*; local: *; };\n' > "$EXPORTS"
  cc -shared -O2 -fPIC -Wall -DDUCKDB_STATIC_BUILD -I"$LIBS" \
     -o "$OUT" shim/duckdb_sqlite_shim.c $ARCHIVES \
     -lstdc++ -lpthread -ldl -lm \
     -Wl,--version-script="$EXPORTS" -Wl,--exclude-libs,ALL \
     -Wl,--gc-sections -ffunction-sections -fdata-sections
fi

strip -x "$OUT" 2>/dev/null || true
echo ">> done: $OUT ($(du -h "$OUT" | cut -f1))"
