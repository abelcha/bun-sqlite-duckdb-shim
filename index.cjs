// duckdb-bun-shim — entrypoint
//
// `require("duckdb-bun-shim")` returns the absolute filesystem path to the
// prebuilt shim shared library for the current platform/arch, as a STRING.
//
//   Database.setCustomSQLite(require("duckdb-bun-shim"));
//
// The binary lives in `prebuilt/<platform>-<arch>.<ext>` next to this file.
// When installed via npm, `__dirname` points inside node_modules, so the path
// resolves to the absolute location Bun's dlopen expects.

"use strict";

const { platform, arch } = require("node:process");

const ext =
  platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";

const path = require("node:path");

module.exports = path.join(
  __dirname,
  "prebuilt",
  `${platform}-${arch}.${ext}`,
);
