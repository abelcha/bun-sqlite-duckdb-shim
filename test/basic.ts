import { Database } from "bun:sqlite";

// Point bun:sqlite at the DuckDB-backed shim. This swaps the engine for the whole
// process; do it before opening any Database.
Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");

const csv = import.meta.dir + "/people.csv";
const db = new Database(":memory:");

// ---------------------------------------------------------------------------
// GOAL 1: run a fixed DuckDB query over a CSV file and get rows back.
//         `SELECT * FROM read_csv('path')` — DuckDB's killer feature.
// ---------------------------------------------------------------------------
console.log("== GOAL 1: SELECT * FROM read_csv('file.csv') ==");
const everyone = db.query(`SELECT * FROM read_csv('${csv}') ORDER BY id`).all();
console.log(everyone);

// DuckDB also accepts the bare path as a table — handy shorthand.
console.log("== (shorthand) SELECT * FROM 'file.csv' ==");
console.log(db.query(`SELECT * FROM '${csv}' ORDER BY id`).all());

// ---------------------------------------------------------------------------
// GOAL 2: fixed file path, but a value in the WHERE clause bound as a parameter.
//         `SELECT * FROM read_csv('path') WHERE id = ?`
// ---------------------------------------------------------------------------
console.log("== GOAL 2: fixed path + WHERE id = ? (positional) ==");
const byId = db.query(`SELECT * FROM read_csv('${csv}') WHERE id = ?`);
console.log("id = 2 ->", byId.get(2));
console.log("id = 3 ->", byId.get(3));

// Filtering on a column with a bound param works too.
console.log("== age >= ? ==");
console.log(db.query(`SELECT name, age FROM read_csv('${csv}') WHERE age >= ? ORDER BY age`).all(30));

// A quick aggregate to show DuckDB's analytical side on the same file.
console.log("== aggregate over the file ==");
console.log(db.query(
  `SELECT COUNT(*) AS n, AVG(age) AS avg_age, MAX(score) AS best FROM read_csv('${csv}')`,
).get());

db.close();
console.log("\nALL OK");
