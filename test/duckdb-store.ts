import { Database } from "bun:sqlite";

// Swap the engine BEFORE opening any connection.
Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");

// store.duckdb was built beforehand with the real duckdb CLI:
//   duckdb test/store.duckdb -c "create or replace my_table as from duckdb_settings()"
//
// This test ONLY reads. It never creates/inserts — so the moment my_table shows up
// with real duckdb_settings() rows, it proves the shim genuinely opened and read the
// on-disk DuckDB file (rather than fabricating its own table).
const db = new Database(import.meta.dir + "/store.duckdb");
const rows = db.query("SELECT * FROM my_table").all();
console.log(rows);
db.close();
