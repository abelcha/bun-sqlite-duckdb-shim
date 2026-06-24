// postinstall — fetch the ONE prebuilt binary matching this machine from the
// GitHub release, so the package works whether installed from npm (which ships
// all platforms) OR from a bare `git clone` / github dependency (no binaries).
//
// Idempotent: skips the download if the file already exists (npm publish path
// ships binaries, so this is a no-op there).
"use strict";

const { existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const VERSION = "v0.1.0";
const REPO = "abelcha/bun-sqlite-duckdb-shim";

const { platform, arch } = process;
const ext = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
// Bun/npm arch names: x64 -> x64, arm64 -> arm64
const file = `${platform}-${arch}.${ext}`;
const dest = join(__dirname, "..", "prebuilt", file);

// Already present (installed from npm with all binaries bundled) → nothing to do.
if (existsSync(dest)) {
  process.exit(0);
}

mkdirSync(join(__dirname, "..", "prebuilt"), { recursive: true });

const url = `https://github.com/${REPO}/releases/download/${VERSION}/${file}`;
console.log(`[duckdb-bun-shim] fetching ${file} from release ${VERSION}...`);

// Use global fetch (Node 18+, Bun). Stream to disk to avoid loading 45MB into RAM.
fetch(url)
  .then(async (res) => {
    if (!res.ok) {
      console.error(`[duckdb-bun-shim] release asset not found (${res.status}): ${url}`);
      console.error(`[duckdb-bun-shim] This platform (${platform}-${arch}) may not have a published binary yet.`);
      process.exit(0); // non-fatal: don't break install on unsupported platforms
    }
    const { createWriteStream } = require("node:fs");
    const stream = createWriteStream(dest);
    for await (const chunk of res.body) stream.write(chunk);
    stream.end();
    await new Promise((r, j) => stream.on("finish", r).on("error", j));
    console.log(`[duckdb-bun-shim] installed ${file}`);
  })
  .catch((err) => {
    console.error(`[duckdb-bun-shim] postinstall failed: ${err.message}`);
    process.exit(0); // non-fatal
  });
