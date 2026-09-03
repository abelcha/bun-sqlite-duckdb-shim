#!/usr/bin/env bash
# Static-link the DuckDB SQLite-ABI shim into ONE self-contained shared library
# per platform. No rpath, no libduckdb.dylib alongside — a single file.
#
# Fetches DuckDB's official `static-libs-*` archive for (os, arch), or builds
# DuckDB from a checked-out source tree when SHIM_DUCKDB_SOURCE_DIR is set.
# In both cases every static archive is linked into the shim and the result is
# prebuilt/<platform>-<arch>.<ext>.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${SHIM_DUCKDB_VERSION:-v2.0.0-alpha39998}"
SOURCE_DIR="${SHIM_DUCKDB_SOURCE_DIR:-}"
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
if [ -z "$SOURCE_DIR" ] && [[ "$VER" == v2.* ]]; then
  echo "ERROR: DuckDB 2 preview releases do not ship static libraries yet." >&2
  echo "       Set SHIM_DUCKDB_SOURCE_DIR to a DuckDB v2 checkout." >&2
  exit 2
fi
if [ -n "$SOURCE_DIR" ]; then
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  BUILD_DIR="${DUCKDB_BUILD_DIR:-$SOURCE_DIR/build/release}"
  CMAKE_GENERATOR="${DUCKDB_CMAKE_GENERATOR:-Ninja}"

  if [ ! -f "$BUILD_DIR/src/libduckdb_static.a" ] ||
     [ ! -f "$BUILD_DIR/extension/libduckdb_generated_extension_loader.a" ] ||
     [ ! -f "$BUILD_DIR/extension/json/libjson_extension.a" ] ||
     [ ! -f "$BUILD_DIR/extension/parquet/libparquet_extension.a" ] ||
     [ ! -f "$BUILD_DIR/extension/core_functions/libcore_functions_extension.a" ]; then
    echo ">> configuring DuckDB source ($VER) -> $BUILD_DIR"
    CMAKE_ARGS=(-DCMAKE_BUILD_TYPE=Release -DBUILD_UNITTESTS=OFF -DBUILD_SHELL=OFF
                "-DDUCKDB_EXPLICIT_VERSION=$VER"
                '-DBUILD_EXTENSIONS=parquet;json'
                -DCMAKE_C_COMPILER_LAUNCHER= -DCMAKE_CXX_COMPILER_LAUNCHER=)
    if [ -n "${DUCKDB_CMAKE_OSX_ARCHITECTURES:-}" ]; then
      CMAKE_ARGS+=("-DCMAKE_OSX_ARCHITECTURES=${DUCKDB_CMAKE_OSX_ARCHITECTURES}")
    fi
    cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G "$CMAKE_GENERATOR" "${CMAKE_ARGS[@]}"
    # Build the extension archives as explicit targets. DuckDB's aggregate
    # static target does not always pull every selected extension archive into
    # the build graph, while the shim links those archives below.
    cmake --build "$BUILD_DIR" --target duckdb_static duckdb_generated_extension_loader json_extension parquet_extension core_functions_extension
  fi

  HDR_DIR="$SOURCE_DIR/src/include"
  LIB_ROOT="$BUILD_DIR"
else
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
  HDR_DIR="$WORK/hdr"
  LIB_ROOT="$WORK/libs"
fi

OUT="$OUTDIR/${TRIPLE}.${EXT}"
echo ">> linking -> $OUT"

if [ -n "$SOURCE_DIR" ]; then
  # Keep the main archive first, then the generated loader and extensions. A
  # Darwin static linker is single-pass for archives; alphabetical ordering
  # can silently omit extension registrations and leave functions unloaded.
  LIBS="$LIB_ROOT/src/libduckdb_static.a"
  LOADER="$LIB_ROOT/extension/libduckdb_generated_extension_loader.a"
  [ -f "$LOADER" ] && LIBS="$LIBS $LOADER"
  LIBS="$LIBS $(find "$LIB_ROOT/extension" -name '*_extension.a' ! -name 'libduckdb_generated_extension_loader.a' | sort)"
  LIBS="$LIBS $(find "$LIB_ROOT/third_party" -name '*.a' | sort)"
else
  LIBS=$(find "$LIB_ROOT" -name '*.a' | sort)
fi

# Target arch: the output triple's arch, NOT the host's (cross-compile support).
case "$TRIPLE" in
  *-arm64|*-aarch64) TARGET_ARCH="arm64" ;;
  *-x64|*-amd64)     TARGET_ARCH="x86_64" ;;
  *)                 TARGET_ARCH="$(uname -m)" ;;
esac

if [ "$EXT" = "dylib" ]; then
  # macOS: clang -arch cross-compiles x86_64 on an arm64 host natively.
  cc -arch "$TARGET_ARCH" -shared -O2 -fPIC -Wall \
     -I"$HDR_DIR" -I"$LIB_ROOT" \
     -o "$OUT" shim/duckdb_sqlite_shim.c \
     $LIBS \
     -lc++ -framework CoreFoundation -framework Security \
     -Wl,-install_name,@rpath/duckdb-bun-shim.dylib \
     -Wl,-dead_strip
elif [ "$EXT" = "so" ]; then
  cc -shared -O2 -fPIC -Wall \
     -I"$HDR_DIR" -I"$LIB_ROOT" \
     -o "$OUT" shim/duckdb_sqlite_shim.c \
     $LIBS \
     -static-libstdc++ -lpthread -ldl -lm \
     -Wl,--gc-sections -ffunction-sections -fdata-sections
else
  # Windows (mingw)
  gcc -shared -O2 -Wall \
     -I"$HDR_DIR" -I"$LIB_ROOT" \
     -o "$OUT" shim/duckdb_sqlite_shim.c \
     $LIBS \
     -lws2_32 -lstdc++ \
     -Wl,--gc-sections
fi

strip -x "$OUT" 2>/dev/null || true
echo ">> done: $OUT ($(du -h "$OUT" | cut -f1))"
