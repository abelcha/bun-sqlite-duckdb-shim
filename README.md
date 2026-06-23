# duckdb-bun-sqlite-shim

Use **[DuckDB](https://duckdb.org/)** as the engine behind Bun's native `bun:sqlite` and
`Bun.SQL` — by swapping the SQLite C library at runtime.

```sh
bun:sqlite  ──┐
              ├──►  libduckdb_sqlite_shim.dylib  ──►  DuckDB
Bun.SQL      ──┘      (SQLite ABI, backed by DuckDB's C API)
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

Database.setCustomSQLite("./vendor/libduckdb_sqlite_shim.dylib");

const sql = new SQL(":memory:");
const rows = await sql`SELECT * FROM read_csv('people.csv') WHERE id = ${2}`;
// → [{ id: 2, name: "Bob", age: 25, score: 9.2 }]
```

CSV, Parquet, JSON, TSV — all of DuckDB's analytical SQL (window functions, CTEs, joins,
aggregates) — with the synchronous `bun:sqlite` API or the async `Bun.SQL` tagged-template
API, no extra dependencies.

## Quick start

Requires `cc`, `curl`, `unzip`, and [Bun](https://bun.sh).

```sh
git clone <this repo>
cd duckdb-bun-shim
make            # fetches libduckdb + builds the shim into ./vendor
bun test/sql-tagged.ts
```

`scripts/build.sh` downloads the official prebuilt `libduckdb` for your platform
(macOS/Linux/Windows, x64/arm64) and compiles the shim against it. Override the version
with `SHIM_DUCKDB_VERSION=v1.5.4`.

## Usage

```ts
import { Database } from "bun:sqlite";

// MUST run before any Database is opened.
Database.setCustomSQLite("./vendor/libduckdb_sqlite_shim.dylib");

// Synchronous (bun:sqlite)
const db = new Database(":memory:");
db.query("SELECT * FROM read_csv('data.csv') ORDER BY id").all();
db.query("SELECT * FROM read_csv('data.csv') WHERE id = ?").get(2);

// Async tagged template (Bun.SQL)
import { SQL } from "bun";
const sql = new SQL(":memory:");
await sql`SELECT * FROM read_csv('data.csv') WHERE id = ${2}`;
```

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
- **`scripts/build.sh`** — fetches `libduckdb` + `duckdb.h` from the GitHub release and
  compiles the shim. The shim and `libduckdb` are placed in the same directory so the
  rpath (`@loader_path` / `$ORIGIN`) resolves at runtime — keep them together when you ship.

Bun treats `sqlite3*` / `sqlite3_stmt*` as opaque pointers, so the shim owns their layout.
`sqlite3_step` materializes the result on the first call and walks a row cursor,
translating DuckDB's success/error into `SQLITE_ROW`/`SQLITE_DONE`.

## Status

**Working:** scalar types (int/float/text/null/bool/blob), positional `?` params,
`CREATE`/`INSERT`/`UPDATE`/`DELETE` with `.changes` tracking, multi-statement `db.run()`,
file reading (CSV/Parquet/JSON), aggregates/joins/CTEs/window functions, error messages,
both the `bun:sqlite` and `Bun.SQL` APIs.

**Known gaps:** named params (`$x`/`:x`/`@x`), `db.transaction()` (SQLite SAVEPOINT
syntax), HUGEINT/DECIMAL precision, nested types (LIST/STRUCT) — see `test/audit.ts` for
the current capability matrix. These are tracked for follow-up.

**Not possible (DuckDB vs SQLite dialect):** `PRAGMA`, `sqlite_master`, `last_insert_rowid`
(DuckDB has no rowid concept), `serialize`/`deserialize`, the `:x`/`@x` param syntaxes
(DuckDB's parser rejects them).

## License

MIT. The built shim links against DuckDB (MIT).
