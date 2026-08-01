// Named parameters and db.transaction() — both need the shim to speak SQLite's dialect
// of the C API (sigil-prefixed param names, savepoint statements, autocommit state).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "./shim";

const db = new Database(":memory:");

test("positional params keep their column names", () => {
  expect(db.query("SELECT ? AS a, ? AS b").get(7, "x")).toEqual({ a: 7, b: "x" });
});

test("named $x params", () => {
  expect(db.query("SELECT $x AS x").get({ $x: 7 })).toEqual({ x: 7 });
  expect(db.query("SELECT $a + $b AS sum").get({ $a: 2, $b: 3 })).toEqual({ sum: 5 });
});

test("named params in strict mode drop the sigil", () => {
  const strict = new Database(":memory:", { strict: true });
  expect(strict.query("SELECT $x AS x").get({ x: 7 })).toEqual({ x: 7 });
  strict.close();
});

test("transaction commits", () => {
  db.run("CREATE TABLE t (id INT)");
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  const many = db.transaction((ids: number[]) => ids.forEach(i => insert.run(i)));
  many([1, 2, 3]);
  expect(db.query("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 3 });
  expect(db.inTransaction).toBe(false);
});

test("transaction rolls back on throw", () => {
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  expect(() => db.transaction(() => { insert.run(4); throw new Error("boom"); })()).toThrow("boom");
  expect(db.query("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 3 });
  expect(db.inTransaction).toBe(false);
});

// DuckDB has no savepoints, so a nested transaction runs inside the outer one: the happy
// path is identical to SQLite, but a nested failure unwinds everything, not just itself.
test("nested transactions", () => {
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  db.transaction(() => {
    insert.run(10);
    db.transaction(() => insert.run(11))();
  })();
  expect(db.query("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 5 });

  expect(() =>
    db.transaction(() => {
      insert.run(20);
      db.transaction(() => { insert.run(21); throw new Error("inner"); })();
    })(),
  ).toThrow("inner");
  expect(db.query("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 5 });
  expect(db.inTransaction).toBe(false);
});

test("explicit BEGIN/COMMIT tracks autocommit", () => {
  db.run("BEGIN");
  expect(db.inTransaction).toBe(true);
  db.run("COMMIT");
  expect(db.inTransaction).toBe(false);
});
