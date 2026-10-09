// Crash regressions + template values inlined as escaped literals (no bound params).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import "./shim";

const db = new Database(":memory:");
const sql = new SQL(":memory:");
const csv = `${import.meta.dir}/people.csv`;

test("UUID followed by another column does not crash", () => {
  const [[u, x]] = db.query("select uuid() u, 1 x").values() as any;
  expect(u).toMatch(/^[0-9a-f-]{36}$/);
  expect(x).toBe(1);
  expect((db.query("select uuid()").values() as any)[0][0]).toHaveLength(36);
});

test("TIMESTAMPTZ / TIME_TZ / TIMESTAMP_MS values are not empty", () => {
  const [[a, b, c]] = db.query("select now(), '12:00:00+02'::timetz, timestamp_ms '2020-01-01'").values() as any;
  expect(a).toMatch(/^\d{4}-\d\d-\d\d /);
  expect(b).toBe("12:00:00+02");
  expect(c).toBe("2020-01-01 00:00:00");
});

test("comment-only / empty SQL does not crash", () => {
  expect(() => db.run("select 1; -- trailing comment")).not.toThrow();
  expect(() => db.run("select 1; /* block */ ; -- x")).not.toThrow();
  expect(() => db.run("-- just a comment")).toThrow(/no valid SQL/);
  expect(db.query("-- lead\nselect 2 x").get()).toEqual({ x: 2 });
});

test("template: value in table position", async () => {
  const rows = await sql`select * from ${csv} where id = ${2}`;
  expect(rows[0].name).toBe("Bob");
});

test("template: value in ORDER BY does not crash", async () => {
  // a bound value is a literal: an integer is a column position, a string is rejected by DuckDB
  const rows = await sql`select * from ${csv} order by ${2} desc limit 2`;
  expect(rows).toHaveLength(2);
  expect(sql`select * from ${csv} order by ${"name"} desc limit 2`.then(() => 0, () => 1)).resolves.toBe(1);
});

test("quotes are escaped", () => {
  expect(db.query("select ? as s").get("O'Brien")).toEqual({ s: "O'Brien" });
  expect(db.query("select ? as s").get("'; drop table x; --")).toEqual({ s: "'; drop table x; --" });
  expect(db.query("select '?' || ? as s").get("a")).toEqual({ s: "?a" });
});

test("NULL, numbers, blobs", () => {
  expect(db.query("select ? as a, ? as b, ? as c, ? as d").get(null, 1, 1.5, -3)).toEqual({ a: null, b: 1, c: 1.5, d: -3 });
  expect(db.query("select 1-? as a").get(-5)).toEqual({ a: 6 });
  expect(db.query("select 5000000000 + ? as a").get(2 ** 40)).toEqual({ a: 5000000000 + 2 ** 40 });
  expect(db.query("select ? as a").get(2.0 ** 70)).toEqual({ a: 2.0 ** 70 });
  const b = db.query("select ? as a").get(new Uint8Array([0, 1, 39, 255])) as any;
  expect([...b.a]).toEqual([0, 1, 39, 255]);
});

test("reused prepared statement with different bindings", () => {
  const q = db.prepare("select ? as a, ? as b");
  expect(q.get(1, "x")).toEqual({ a: 1, b: "x" });
  expect(q.get(2, "y'z")).toEqual({ a: 2, b: "y'z" });
  expect(q.all(3, null)).toEqual([{ a: 3, b: null }]);
  expect(q.columnNames).toEqual(["a", "b"]);
});

test("named params and repeated names", () => {
  expect(db.query("select $x + $x as s, $y as y").get({ $x: 2, $y: "q" })).toEqual({ s: 4, y: "q" });
  expect(db.query("select $1 as a, $2 as b").get(7, 8)).toEqual({ a: 7, b: 8 });
});

test("placeholders inside strings and comments are not parameters", () => {
  const q = db.prepare("select '?' as a, ? as c -- ?\n, 1 /* ? */ as d");
  expect(q.get(9)).toEqual({ a: "?", c: 9, d: 1 });
});

test("INSERT with params and transaction", () => {
  db.run("create table r (id int, s varchar)");
  const ins = db.prepare("insert into r values (?, ?)");
  db.transaction(() => { ins.run(1, "a'b"); ins.run(2, null); })();
  expect(db.query("select * from r order by id").all()).toEqual([{ id: 1, s: "a'b" }, { id: 2, s: null }]);
});

test("closing with live statements does not crash", () => {
  const d = new Database(":memory:");
  const q = d.query("select 1 x");
  q.get();
  d.close();
});
