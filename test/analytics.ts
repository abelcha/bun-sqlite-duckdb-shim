import { Database } from "bun:sqlite";

Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");
const db = new Database(":memory:");
const csv = import.meta.dir + "/people.csv";

// window functions
console.log("ranked by score:");
console.log(db.query(`
  SELECT name, score,
         RANK() OVER (ORDER BY score DESC) AS rank
  FROM read_csv('${csv}')
`).all());

// grouped aggregate with bound filter param
const minAge = 28;
console.log("\ngrouped (age >= " + minAge + "):");
console.log(db.query(`
  SELECT CASE WHEN age >= 35 THEN 'senior' ELSE 'mid' END AS bucket,
         COUNT(*) AS n, AVG(score) AS avg_score
  FROM read_csv('${csv}') WHERE age >= ?
  GROUP BY bucket ORDER BY bucket
`).all(minAge));
