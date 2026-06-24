// duckdb-bun-shim — entrypoint
//
//   Database.setCustomSQLite(require("duckdb-bun-shim"));
//
// `require()` returns the absolute path to the prebuilt, statically-linked
// DuckDB shim for this platform/arch, as a STRING.
//
// • When installed from npm, the binary ships inside the package → instant.
// • When installed from a bare git clone / github dependency, the binary is
//   gitignored — so on first require() we fetch the matching asset from the
//   GitHub release SYNCHRONOUSLY (spawnSync curl), cache it, and return the
//   path. No postinstall script, no `trustedDependencies`, no await, no
//   preload, no plugin. First run downloads once; every run after is instant.
//
// `require()` is synchronous, and setCustomSQLite needs a real file on disk
// before any Database is opened — so the rare cold-start download must be
// synchronous. spawnSync is the only sync download primitive available.

"use strict";

const { platform, arch } = require("node:process");
const { existsSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const VERSION = "v0.1.4";
const REPO = "abelcha/bun-sqlite-duckdb-shim";

const ext = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
const file = `${platform}-${arch}.${ext}`;
const dir = join(__dirname, "prebuilt");
const path = join(dir, file);

// Fast path: binary already present (npm bundle, or a previous fetch).
if (!existsSync(path)) {
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/${VERSION}/${file}`;

  // Sync download. curl ships on macOS + Linux. Fall back to wget.
  const args = ["-fsSL", "--retry", "3", "-o", path, url];
  let r = spawnSync("curl", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    r = spawnSync("wget", ["-q", "--tries=3", "-O", path, url], { stdio: ["ignore", "inherit", "inherit"] });
  }
  if (!existsSync(path)) {
    throw new Error(
      `duckdb-bun-shim: failed to fetch ${file} from ${url} ` +
      `(curl exit ${r.status}). This platform (${platform}-${arch}) may not have a published binary yet.`,
    );
  }
}

module.exports = path;
