# duckdb-bun-shim

Use **[DuckDB](https://duckdb.org/)** as the engine behind Bun's native `bun:sqlite` and
`Bun.SQL` — by swapping the SQLite C library at runtime.

```sh
bun:sqlite  ──┐
              ├──►  duckdb-bun-shim  ──►  DuckDB
Bun.SQL      ──┘     (one binary: SQLite ABI + statically-linked libduckdb)
```

Bun lets you replace its SQLite engine with `Database.setCustomSQLite(path)`. It
`dlopen`s the library and resolves the `sqlite3_*` C symbols by name. This repo provides
a **shim** that exports those exact symbols and translates each one to DuckDB's own C API
— so everything Bun drives through `bun:sqlite` (and through `Bun.SQL`, whose SQLite
adapter is built on top of `bun:sqlite`) actually runs on DuckDB.

## Why

DuckDB's killer feature is querying files directly:

```ts
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import shim from "duckdb-bun-shim";

Database.setCustomSQLite(shim);

const sql = new SQL(":memory:");
const rows = await sql`SELECT * FROM read_csv('people.csv') WHERE id = ${2}`;
// → [{ id: 2, name: "Bob", age: 25, score: 9.2 }]
```

CSV, Parquet, JSON, TSV — all of DuckDB's analytical SQL (window functions, CTEs, joins,
aggregates) — with the synchronous `bun:sqlite` API or the async `Bun.SQL` tagged-template
API, no extra dependencies.

## Quick start

```sh
bun add abelcha/bun-sqlite-duckdb-shim
```

No postinstall, no `trustedDependencies`, no build step — the shim and DuckDB are a
single statically-linked binary (~46 MB, `darwin-arm64` / `darwin-x64` / `linux-x64` /
`linux-arm64`).

## Usage

```ts
import { Database } from "bun:sqlite";
import shim from "duckdb-bun-shim"; // absolute path to the binary for this platform/arch

// MUST run before any Database is opened.
Database.setCustomSQLite(shim);

// Synchronous (bun:sqlite)
const db = new Database(":memory:");
db.query("SELECT * FROM read_csv('data.csv') ORDER BY id").all();
db.query("SELECT * FROM read_csv('data.csv') WHERE id = ?").get(2);

// Async tagged template (Bun.SQL)
import { SQL } from "bun";
const sql = new SQL(":memory:");
await sql`SELECT * FROM read_csv('data.csv') WHERE id = ${2}`;
```

The binary isn't committed to git, so on a github install the first import fetches it from
the matching release (synchronously, via `curl`) and caches it in `prebuilt/` — every run
after that is instant. An npm publish bundles it, so there's nothing to fetch.

The import is a plain string path, so CommonJS works too:
`Database.setCustomSQLite(require("duckdb-bun-shim"))`.

### The one DuckDB rule to know

The file path must be a **literal** in the SQL (DuckDB reads the header to infer the
schema at prepare time), so it can't be a bound `${...}` param. Filter *values* in the
WHERE clause, on the other hand, bind normally — exactly what you'd want:

```ts
// ✓ literal path, bound value
await sql`SELECT * FROM read_csv('data.csv') WHERE id = ${id}`;

// ✗ path as a param — DuckDB can't infer the schema, columns come back as "unknown"
await sql`SELECT * FROM read_csv(${path}) WHERE id = ${id}`;
```

For a dynamic path, interpolate it into the SQL string and bind the values separately:
```ts
await sql.unsafe(`SELECT * FROM read_csv('${path}') WHERE id = ?`, [id]);
```

## How it works

- **`shim/duckdb_sqlite_shim.c`** — ~600 lines of C. Exports the ~50 `sqlite3_*` symbols
  that Bun's [`lazy_sqlite3.h`](https://github.com/oven-sh/bun/blob/main/src/jsc/bindings/sqlite/lazy_sqlite3.h)
  resolves via `dlsym`, each translating to the DuckDB C API. Real translations where it
  matters (open/prepare/step/bind/column), safe no-op stubs for SQLite features with no
  DuckDB equivalent (`serialize`, `file_control`, `load_extension`).
- **`scripts/build-static.sh`** — fetches DuckDB's static libs + `duckdb.h` and links them
  into the shim, so the published artifact is one self-contained file with no `libduckdb`
  next to it and no rpath to get wrong.
- **`index.cjs`** — resolves `prebuilt/<platform>-<arch>.<ext>`, fetching it on first
  `require()` if missing.

Bun treats `sqlite3*` / `sqlite3_stmt*` as opaque pointers, so the shim owns their layout.
`sqlite3_step` materializes the result on the first call and walks a row cursor,
translating DuckDB's success/error into `SQLITE_ROW`/`SQLITE_DONE`.

## Building from source

Requires `cc`, `curl`, `unzip`, and [Bun](https://bun.sh).

```sh
bun run build:static   # → prebuilt/<platform>-<arch>.<ext>, self-contained
make                   # dynamic build against libduckdb → ./vendor (dev loop)
bun test
```

Override the DuckDB version with `SHIM_DUCKDB_VERSION=v1.5.4` (the current default).

## Status

**Working:** scalar types (int/float/text/null/bool/blob), positional `?` and named `$x`
params, `db.transaction()` (commit + rollback), `CREATE`/`INSERT`/`UPDATE`/`DELETE` with
`.changes` tracking, multi-statement `db.run()`, file reading (CSV/Parquet/JSON),
aggregates/joins/CTEs/window functions, error messages, both the `bun:sqlite` and
`Bun.SQL` APIs.

**Nested types** (STRUCT/LIST/MAP/ARRAY/UNION) come back as JSON text — `JSON.parse` them:

```ts
JSON.parse(db.query("SELECT {'a': 1, 'b': 'two'} AS score").get().score); // { a: 1, b: "two" }
```

HUGEINT and DECIMAL come back as text too, since neither fits a JS number losslessly.

**Known gaps:** a nested column selected alongside a `?` *in the SELECT list*
(`SELECT {'a': ?}`) stays empty — DuckDB can't resolve result types before binding, so
the JSON rewrite has nothing to key off. Nested transactions collapse into the outermost
one (DuckDB has no savepoints), so a nested failure unwinds the whole transaction. See
`test/audit.ts`, `test/nested.ts`, `test/params-tx.ts`.

**Not possible (DuckDB vs SQLite dialect):** `PRAGMA`, `sqlite_master`, `last_insert_rowid`
(DuckDB has no rowid concept), `serialize`/`deserialize`, the `:x`/`@x` param syntaxes
(DuckDB's parser rejects them).

## License

MIT. The built shim links against DuckDB (MIT).
