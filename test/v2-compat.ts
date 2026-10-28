// DuckDB 2 compatibility checks.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "./shim";

const db = new Database(":memory:");
const one = (sql: string) => db.query(sql).get() as Record<string, unknown>;

test("the loaded engine matches the published DuckDB 2", () => {
  expect(String(one("SELECT version() AS version").version)).toBe("v2.0.0");
});

test("VARIANT is materialized as JSON text", () => {
  expect(JSON.parse(String(one("SELECT 42::VARIANT AS value").value))).toBe(42);
});

test("DuckDB 2 CONNECT is accepted through the SQLite ABI", () => {
  db.run("ATTACH ':memory:' AS remote");
  // The statement reaches DuckDB's CONNECT executor. An in-memory database is
  // deliberately not a CONNECT backend, so this is the deterministic engine
  // error that proves parsing/dispatch succeeded.
  expect(() => db.run("CONNECT remote")).toThrow(/does not support CONNECT/i);
  db.run("DETACH remote");
});

test("DuckDB 2 triggers remain usable through the shim", () => {
  db.run("CREATE TABLE source (value INTEGER)");
  db.run("CREATE TABLE audit (value INTEGER)");
  db.run("CREATE TRIGGER source_audit AFTER INSERT ON source REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT INSERT INTO audit SELECT value FROM inserted");
  db.run("INSERT INTO source VALUES (7)");
  expect(one("SELECT value FROM audit")).toEqual({ value: 7 });
});

test("statically linked extensions are loaded", () => {
  const loaded = db.query("SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1").values().flat();
  expect(loaded).toEqual(["core_functions", "icu", "json", "parquet"]);
});

test("strings outside Latin-1 bind as UTF-16 (bind_text64 enc)", () => {
  expect(db.query("SELECT ? AS v").get("🍕 l'emoji ’")).toEqual({ v: "🍕 l'emoji ’" });
});

test("ATTACH a SQLite database through the sqlite extension", () => {
  const path = `${require("node:os").tmpdir()}/shim-${Date.now()}.sqlite`;
  db.run(`ATTACH '${path}' AS lite (TYPE sqlite)`);
  db.run("CREATE TABLE lite.t AS SELECT 1 AS id, '🍕' AS name");
  db.run("DETACH lite");
  db.run(`ATTACH '${path}' AS lite (TYPE sqlite, READ_ONLY)`);
  expect(db.query("FROM lite.t").all()).toEqual([{ id: 1, name: "🍕" }]);
  db.run("DETACH lite");
});

test("INSTALL / LOAD a core extension", () => {
  db.run("INSTALL spatial");
  db.run("LOAD spatial");
  expect(one("SELECT ST_AsText(ST_Point(1, 2)) AS p")).toEqual({ p: "POINT (1 2)" });
});

test("INSTALL / LOAD a community extension", () => {
  db.run("INSTALL h3 FROM community");
  db.run("LOAD h3");
  expect(one("SELECT h3_latlng_to_cell(48.85, 2.35, 9)::VARCHAR AS c")).toEqual({ c: "617550903641899007" });
});

test("httpfs autoloads for remote files", () => {
  expect(one("SELECT count() AS n FROM read_parquet('https://blobs.duckdb.org/data/taxi_2019_04.parquet')")).toEqual({ n: 7433139 });
});

test("declaredTypes / columnTypes after execution", () => {
  const q = db.query("SELECT true AS b, [1] AS l, {'a': 1} AS s, 1.5::DECIMAL(4,1) AS d, 'x' AS v");
  q.get();
  expect(q.declaredTypes).toEqual(["BOOLEAN", "JSON", "JSON", "DECIMAL", "VARCHAR"]);
  expect(q.columnTypes).toEqual(["INTEGER", "TEXT", "TEXT", "FLOAT", "TEXT"]);
});
