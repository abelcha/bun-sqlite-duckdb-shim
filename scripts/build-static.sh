#!/usr/bin/env bash
# Static-link the DuckDB SQLite-ABI shim into ONE self-contained shared library
# per platform. No rpath, no libduckdb.dylib alongside — a single file.
#
# Fetches DuckDB's official `static-libs-*` archive for (os, arch), links every
# bundled .a into the shim, emits prebuilt/<platform>-<arch>.<ext>.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${SHIM_DUCKDB_VERSION:-v1.5.4}"
WORK="${WORK:-$(mktemp -d)}"
OUTDIR="${OUTDIR:-prebuilt}"
mkdir -p "$OUTDIR"

# ---- map (os, arch) -> static asset + output triple ----
# SHIM_TRIPLE overrides the host, so CI can cross-compile (e.g. darwin-x64
# built on an arm64 mac runner via `clang -arch x86_64`).
detect() {
  local host_triple
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)   host_triple="darwin-arm64" ;;
    Darwin/x86_64)  host_triple="darwin-x64" ;;
    Linux/x86_64)   host_triple="linux-x64" ;;
    Linux/aarch64)  host_triple="linux-arm64" ;;
    Linux/arm64)    host_triple="linux-arm64" ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64) host_triple="win32-x64" ;;
    *) echo "ERROR: no static asset for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
  esac
  local t="${SHIM_TRIPLE:-$host_triple}"
  case "$t" in
    darwin-arm64) echo "static-libs-osx-arm64.zip|$t|dylib" ;;
    darwin-x64)   echo "static-libs-osx-amd64.zip|$t|dylib" ;;
    linux-x64)    echo "static-libs-linux-amd64.zip|$t|so" ;;
    linux-arm64)  echo "static-libs-linux-arm64.zip|$t|so" ;;
    win32-x64)    echo "static-libs-windows-mingw.zip|$t|dll" ;;
    *) echo "ERROR: unknown SHIM_TRIPLE=$t" >&2; exit 1 ;;
  esac
}

IFS='|' read -r ASSET TRIPLE EXT <<<"$(detect)"
URL="https://github.com/duckdb/duckdb/releases/download/${VER}/${ASSET}"
echo ">> fetching $ASSET"
curl -fsSL "$URL" -o "$WORK/s.zip"
mkdir -p "$WORK/libs"; unzip -oq "$WORK/s.zip" -d "$WORK/libs"

# duckdb.h — grab from the matching libduckdb zip (same header across assets)
if [ ! -f "$WORK/hdr/duckdb.h" ]; then
  case "$TRIPLE" in
    darwin-*)   HDR="libduckdb-osx-universal.zip";;
    linux-x64)  HDR="libduckdb-linux-amd64.zip";;
    linux-arm64) HDR="libduckdb-linux-arm64.zip";;
    win32-*)    HDR="libduckdb-windows-amd64.zip";;
  esac
  curl -fsSL "https://github.com/duckdb/duckdb/releases/download/${VER}/${HDR}" -o "$WORK/h.zip"
  mkdir -p "$WORK/hdr"; unzip -oq "$WORK/h.zip" -d "$WORK/hdr"
fi

OUT="$OUTDIR/${TRIPLE}.${EXT}"
echo ">> linking -> $OUT"

LIBS=$(find "$WORK/libs" -name '*.a' | sort)

# Target arch: the output triple's arch, NOT the host's (cross-compile support).
case "$TRIPLE" in
  *-arm64|*-aarch64) TARGET_ARCH="arm64" ;;
  *-x64|*-amd64)     TARGET_ARCH="x86_64" ;;
  *)                 TARGET_ARCH="$(uname -m)" ;;
esac

if [ "$EXT" = "dylib" ]; then
  # macOS: clang -arch cross-compiles x86_64 on an arm64 host natively.
  cc -arch "$TARGET_ARCH" -shared -O2 -fPIC -Wall \
     -I"$WORK/hdr" -I"$WORK/libs" \
     -o "$OUT" shim/duckdb_sqlite_shim.c \
     $LIBS \
     -lc++ -framework CoreFoundation -framework Security \
     -Wl,-install_name,@rpath/duckdb-bun-shim.dylib \
     -Wl,-dead_strip
elif [ "$EXT" = "so" ]; then
  cc -shared -O2 -fPIC -Wall \
     -I"$WORK/hdr" -I"$WORK/libs" \
     -o "$OUT" shim/duckdb_sqlite_shim.c \
     $LIBS \
     -static-libstdc++ -lpthread -ldl -lm \
     -Wl,--gc-sections -ffunction-sections -fdata-sections
else
  # Windows (mingw)
  gcc -shared -O2 -Wall \
     -I"$WORK/hdr" -I"$WORK/libs" \
     -o "$OUT" shim/duckdb_sqlite_shim.c \
     $LIBS \
     -lws2_32 -lstdc++ \
     -Wl,--gc-sections
fi

strip -x "$OUT" 2>/dev/null || true
echo ">> done: $OUT ($(du -h "$OUT" | cut -f1))"
