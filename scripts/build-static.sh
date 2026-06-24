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
detect() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)   echo "static-libs-osx-arm64.zip|darwin-arm64|dylib" ;;
    Darwin/x86_64)  echo "static-libs-osx-amd64.zip|darwin-x64|dylib" ;;
    Linux/x86_64)   echo "static-libs-linux-amd64.zip|linux-x64|so" ;;
    Linux/aarch64)  echo "static-libs-linux-arm64.zip|linux-arm64|so" ;;
    Linux/arm64)    echo "static-libs-linux-arm64.zip|linux-arm64|so" ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64) echo "static-libs-windows-mingw.zip|win32-x64|dll" ;;
    *) echo "ERROR: no static asset for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
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
ARCH=$(uname -m 2>/dev/null || echo x86_64)

if [ "$EXT" = "dylib" ]; then
  cc -arch "$ARCH" -shared -O2 -fPIC -Wall \
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
