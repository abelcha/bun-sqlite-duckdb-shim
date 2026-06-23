#!/usr/bin/env bash
# Downloads the official prebuilt libduckdb (matching SHIM_DUCKDB_VERSION) for the
# current platform into ./vendor, then compiles the SQLite-ABI shim against it.
#
# Result:  ./vendor/libduckdb_sqlite_shim.<so|dylib|dll>
# The shim and libduckdb are placed in the SAME directory so the shim's @loader_path /
# $ORIGIN rpath resolves libduckdb at runtime. Keep them together when you ship.
set -euo pipefail

cd "$(dirname "$0")/.."

SHIM_DUCKDB_VERSION="${SHIM_DUCKDB_VERSION:-v1.5.4}"
VENDOR_DIR="${VENDOR_DIR:-vendor}"
mkdir -p "$VENDOR_DIR"

# ---- map (os, arch) -> prebuilt asset name ----
detect_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/*)        echo "libduckdb-osx-universal.zip" ;;
    Linux/x86_64)    echo "libduckdb-linux-amd64.zip" ;;
    Linux/aarch64)   echo "libduckdb-linux-arm64.zip" ;;
    Linux/arm64)     echo "libduckdb-linux-arm64.zip" ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64) echo "libduckdb-windows-amd64.zip" ;;
    MINGW*/aarch64|MSYS*/aarch64)              echo "libduckdb-windows-arm64.zip" ;;
    *) echo "ERROR: no prebuilt libduckdb asset for $os/$arch" >&2; exit 1 ;;
  esac
}

# ---- 1. fetch libduckdb + duckdb.h (skip if already present) ----
if [ ! -f "$VENDOR_DIR/duckdb.h" ] || [ ! -f "$VENDOR_DIR"/libduckdb.* ]; then
  ASSET="$(detect_asset)"
  URL="https://github.com/duckdb/duckdb/releases/download/${SHIM_DUCKDB_VERSION}/${ASSET}"
  echo ">> fetching $ASSET"
  curl -fL "$URL" -o "$VENDOR_DIR/libduckdb.zip"
  unzip -o "$VENDOR_DIR/libduckdb.zip" -d "$VENDOR_DIR" >/dev/null
  rm -f "$VENDOR_DIR/libduckdb.zip"
fi

# ---- 2. compile the shim ----
OS="$(uname -s)"
INCLUDE="-I$VENDOR_DIR"
LIBDIR="-L$VENDOR_DIR"

if [ "$OS" = "Darwin" ]; then
  EXT=dylib
  ARCH_FLAGS="-arch $(uname -m)"
  RPATH="-Xlinker -rpath -Xlinker @loader_path"
  OUTPUT="$VENDOR_DIR/libduckdb_sqlite_shim.dylib"
elif [ "$OS" = "Linux" ]; then
  EXT=so
  ARCH_FLAGS=""
  RPATH="-Xlinker -rpath -Xlinker \$ORIGIN"
  OUTPUT="$VENDOR_DIR/libduckdb_sqlite_shim.so"
else
  # Windows: cl.exe or x86_64-w64-mingw32-gcc
  EXT=dll
  if command -v cl.exe >/dev/null 2>&1; then
    : # handled below
  fi
  ARCH_FLAGS=""
  RPATH=""
  OUTPUT="$VENDOR_DIR/libduckdb_sqlite_shim.dll"
fi

echo ">> building shim -> $OUTPUT"

if [ "$OS" = "Darwin" ] || [ "$OS" = "Linux" ]; then
  cc $ARCH_FLAGS -shared -O2 -Wall -Wextra \
    $INCLUDE -o "$OUTPUT" \
    shim/duckdb_sqlite_shim.c \
    $LIBDIR -lduckdb $RPATH \
    $([ "$OS" = "Darwin" ] && echo "-Wl,-install_name,@rpath/libduckdb_sqlite_shim.dylib")
elif [ "${OS#MINGW}" != "$OS" ] || [ "${OS#MSYS}" != "$OS" ] || [ "${OS#CYGWIN}" != "$OS" ]; then
  gcc -shared -O2 -Wall -Wextra \
    $INCLUDE -o "$OUTPUT" \
    shim/duckdb_sqlite_shim.c \
    $LIBDIR -lduckdb
else
  echo "ERROR: unsupported OS $OS for compilation" >&2; exit 1
fi

echo ">> done. load with:  Database.setCustomSQLite(\"$OUTPUT\")"
echo "   (keep it next to libduckdb.$EXT in $VENDOR_DIR/)"
