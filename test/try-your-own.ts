import { Database } from "bun:sqlite";

Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");
const db = new Database(":memory:");

// 👉 Put YOUR file path here. Works with .csv, .parquet, .json, .tsv, .ndjson...
const path = process.argv[2] ?? (import.meta.dir + "/people.csv");

// First: see the schema
console.log("schema:");
console.log(db.query(`DESCRIBE SELECT * FROM read_csv('${path}')`).all());

console.log("\nfirst 5 rows:");
console.log(db.query(`SELECT * FROM read_csv('${path}') LIMIT 5`).all());

db.close();
