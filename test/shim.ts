// setCustomSQLite can only be called once per process, so suites share this module.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const triple = `${process.platform}-${process.arch}`;
const prebuilt = `${import.meta.dir}/../prebuilt/${triple}.${ext}`;
const vendor = `${import.meta.dir}/../vendor/libduckdb_sqlite_shim.${ext}`;
Database.setCustomSQLite(process.env.DUCKDB_SHIM_LIBRARY ?? (existsSync(prebuilt) ? prebuilt : vendor));
