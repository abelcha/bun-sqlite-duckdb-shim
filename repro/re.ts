import { Database } from "bun:sqlite";
import shim from "duckdb-bun-shim"; // absolute path to the binary for this platform/arch

// MUST run before any Database is opened.
Database.setCustomSQLite(shim);
const db = new Database(":memory:");
const resp = await db.query(`SELECT * FROM duckdb_settings()`)
console.log({ resp })
// db.query("SELECT * FROM read_csv('data.csv') ORDER BY id").all();
// db.query("SELECT * FROM read_csv('data.csv') WHERE id = ?").get(2);

// re.sql(`--sql
// SELECT * FROM users`)
// Bun.sql`SELECT * FROM users`