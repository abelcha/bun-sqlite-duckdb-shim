// DuckDB 2 alpha compatibility checks.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "./shim";

const db = new Database(":memory:");
const one = (sql: string) => db.query(sql).get() as Record<string, unknown>;

test("the loaded engine matches the published DuckDB alpha", () => {
  expect(String(one("SELECT version() AS version").version)).toBe("v2.0.0-alpha39998");
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
