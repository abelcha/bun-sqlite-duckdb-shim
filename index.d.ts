/**
 * Absolute filesystem path to the prebuilt DuckDB SQLite-ABI shim for the
 * current platform/arch. Pass it to `Database.setCustomSQLite(...)`.
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import shim from "duckdb-bun-shim";
 * Database.setCustomSQLite(shim);
 * ```
 */
declare const path: string;
export = path;
