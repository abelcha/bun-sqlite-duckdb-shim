// Nested / exotic DuckDB types. DuckDB's value API returns "" for these, so the shim
// re-prepares the SELECT with those columns cast (JSON for nested, VARCHAR otherwise).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");

const db = new Database(":memory:");
const one = (sql: string, ...p: any[]) => db.query(sql).get(...p) as any;

test("struct", () => {
  expect(JSON.parse(one("SELECT {'a': 1, 'b': 'two'} AS score").score)).toEqual({ a: 1, b: "two" });
});

test("list", () => {
  expect(JSON.parse(one("SELECT [1,2,3] AS l").l)).toEqual([1, 2, 3]);
});

test("map", () => {
  expect(JSON.parse(one("SELECT MAP{'k': 1} AS m").m)).toEqual({ k: 1 });
});

test("array", () => {
  expect(JSON.parse(one("SELECT [1,2,3]::INT[3] AS a").a)).toEqual([1, 2, 3]);
});

test("deeply nested", () => {
  const r = one("SELECT {'x': [1,2], 'y': {'z': [{'q': 'deep'}]}} AS v");
  expect(JSON.parse(r.v)).toEqual({ x: [1, 2], y: { z: [{ q: "deep" }] } });
});

test("union / enum / bit are not empty", () => {
  expect(JSON.parse(one("SELECT union_value(k := 3) AS u").u)).toEqual({ k: 3 });
  expect(one("SELECT 'a'::enum('a','b') AS e").e).toBe("a");
  expect(one("SELECT '101'::BIT AS b").b).toBe("101");
});

test("scalar columns keep their JS types alongside a struct", () => {
  const r = one("SELECT 42 AS n, 3.14::DOUBLE AS f, 'txt' AS s, true AS bo, NULL AS nul, {'a': 1} AS st");
  expect(r.n).toBe(42);
  expect(r.f).toBe(3.14);
  expect(r.s).toBe("txt");
  expect(r.bo).toBe(1);
  expect(r.nul).toBe(null);
  expect(JSON.parse(r.st)).toEqual({ a: 1 });
  // DECIMAL/HUGEINT stay text on purpose — they don't fit a JS number losslessly.
  expect(one("SELECT 1.5 AS d, SUM(v) AS h FROM (SELECT UNNEST([1,2,3]) AS v)")).toEqual({ d: "1.5", h: "6" });
});

test("struct from a table, filtered", () => {
  db.run("CREATE TABLE people (id INT, info STRUCT(name VARCHAR, age INT))");
  db.run("INSERT INTO people VALUES (1, {'name': 'alice', 'age': 30}), (2, {'name': 'bob', 'age': 25})");
  const r = one("SELECT info FROM people WHERE id = ?", 2);
  expect(JSON.parse(r.info)).toEqual({ name: "bob", age: 25 });
  expect(db.query("SELECT info FROM people ORDER BY id").all()).toHaveLength(2);
});

test("NULL struct stays null", () => {
  expect(one("SELECT NULL::STRUCT(a INT) AS s").s).toBe(null);
});

test("quoted / duplicated column names don't break the rewrite", () => {
  expect(JSON.parse(one(`SELECT {'a': 1} AS "we""ird"`)['we"ird'])).toEqual({ a: 1 });
  // duplicate names can't be REPLACE'd — must fall back, not throw
  expect(() => db.query("SELECT * FROM (SELECT {'a': 1} AS s) t1, (SELECT {'b': 2} AS s) t2").get()).not.toThrow();
});

test("trailing semicolon and multi-statement runs are unaffected", () => {
  expect(JSON.parse(one("SELECT [1,2] AS l;  ").l)).toEqual([1, 2]);
  db.run("CREATE TABLE t2 (i INT); INSERT INTO t2 VALUES (1); INSERT INTO t2 VALUES (2);");
  expect(one("SELECT COUNT(*) AS c FROM t2").c).toBe(2);
});

test("CTEs and aggregates producing lists", () => {
  const r = one("WITH x AS (SELECT UNNEST([1,2,3]) AS v) SELECT list(v) AS agg, COUNT(v) AS n FROM x");
  expect(JSON.parse(r.agg)).toEqual([1, 2, 3]);
  expect(r.n).toBe(3);
});

// Pre-existing, unrelated to nesting: when a `?` sits in the SELECT list, DuckDB can't
// resolve the result types at prepare time, so column metadata (and the cast rewrite)
// is unavailable — the row comes back as a single "unknown" column.
test.todo("params in the projection", () => {
  expect(JSON.parse(one("SELECT {'id': ?} AS s", 7).s)).toEqual({ id: 7 });
});
