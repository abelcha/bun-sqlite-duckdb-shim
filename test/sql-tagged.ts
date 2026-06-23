import { Database } from "bun:sqlite";
import { SQL } from "bun";

// Swap the engine BEFORE opening any connection.
Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");

const sql = new SQL(":memory:");

// The path is a literal in the SQL; the value binds as a param. Exactly the syntax
// from docs/runtime/sql.mdx, but running on DuckDB.
const id = 2;
const rows = await sql`SELECT * FROM read_csv('/Volumes/build/duckdb-bun-shim/test/people.csv') WHERE id = ${id}`;
console.log(rows);

await sql.close();
