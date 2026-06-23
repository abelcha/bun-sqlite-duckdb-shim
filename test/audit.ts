import { Database } from "bun:sqlite";

Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");

function test(name, fn) {
  try {
    const r = fn();
    console.log(`✓ ${name}: ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`✗ ${name}: ${e.message.split("\n")[0]}`);
  }
}

const db = new Database(":memory:");
const csv = import.meta.dir + "/people.csv";

// 1. literals & types
test("int", () => db.query("SELECT 42 AS x").get());
test("float", () => db.query("SELECT 3.14 AS x").get());
test("text", () => db.query("SELECT 'hello' AS x").get());
test("null", () => db.query("SELECT NULL AS x").get());
test("bool", () => db.query("SELECT true AS x").get());

// 2. positional params
test("positional ?", () => db.query("SELECT ? AS x").get(7));

// 3. named params (sqlite-style)
test("named $x", () => db.query("SELECT $x AS x").get({ $x: 7 }));
test("named :x", () => db.query("SELECT :x AS x").get({ ":x": 7 }));
test("named @x", () => db.query("SELECT @x AS x").get({ "@x": 7 }));

// 4. CREATE / INSERT / changes
test("create+insert", () => {
  db.run("CREATE TABLE t(id INTEGER, name VARCHAR)");
  const stmt = db.prepare("INSERT INTO t VALUES (?, ?)");
  return { r1: stmt.run(1, "alice").changes, r2: stmt.run(2, "bob").changes };
});
test("lastInsertRowid", () => db.prepare("INSERT INTO t VALUES (?, ?)").run(3, "carol").lastInsertRowid);
test("select after insert", () => db.query("SELECT * FROM t ORDER BY id").all());

// 5. transactions
test("transaction", () => {
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO t VALUES (?, ?)").run(4, "dave");
    return db.query("SELECT COUNT(*) AS c FROM t").get().c;
  });
  return tx();
});

// 6. multiple statements in one run()
test("multi-statement", () => db.run("INSERT INTO t VALUES (5, 'eve'); INSERT INTO t VALUES (6, 'frank');"));

// 7. UPDATE/DELETE
test("update", () => db.prepare("UPDATE t SET name = ? WHERE id = ?").run("ALICE", 1).changes);
test("delete", () => db.prepare("DELETE FROM t WHERE id = ?").run(6).changes);

// 8. duckdb types
test("bigint", () => db.query("SELECT 1000000000000::BIGINT AS x").get());
test("hugeint", () => db.query("SELECT 170141183460469231731687303715884105727::HUGEINT AS x").get());
test("list type", () => db.query("SELECT [1,2,3] AS x").get());
test("struct type", () => db.query("SELECT {'a': 1, 'b': 'two'} AS x").get());
test("date", () => db.query("SELECT DATE '2024-01-15' AS x").get());
test("timestamp", () => db.query("SELECT TIMESTAMP '2024-01-15 10:30:00' AS x").get());

// 9. file reading
test("csv file", () => db.query(`SELECT COUNT(*) AS c FROM read_csv('${csv}')`).get());

// 10. error handling
test("syntax error", () => { db.query("SELECT FROM"); });

db.close();
