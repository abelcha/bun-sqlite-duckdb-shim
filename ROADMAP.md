# Status & Roadmap

Current state of the DuckDB-ABI shim, what works, what's next, and what can't be done.
The test results below come from `bun test/audit.ts` — a live capability matrix.

---

## ✅ Working (tested)

| Feature | bun:sqlite | Bun.SQL |
|---------|:---:|:---:|
| Scalar types: INTEGER, FLOAT/DOUBLE, VARCHAR, NULL, BOOLEAN | ✓ | ✓ |
| BIGINT (fits in `int64`) | ✓ | ✓ |
| BLOB → `Uint8Array` | ✓ | ✓ |
| DATE / TIMESTAMP (as ISO text) | ✓ | ✓ |
| Positional `?` params | ✓ | ✓ |
| `CREATE` / `INSERT` / `UPDATE` / `DELETE` | ✓ | ✓ |
| `.changes` / rows-affected tracking | ✓ | ✓ |
| Multi-statement `db.run("a; b;")` | ✓ | — |
| **File reading: `read_csv('file.csv')`** | ✓ | ✓ |
| **File reading: Parquet, JSON, TSV** | ✓ | ✓ |
| Aggregates, JOINs, CTEs, window functions | ✓ | ✓ |
| `SELECT * FROM 'path.csv'` shorthand | ✓ | ✓ |
| Real DuckDB error messages surfaced on throw | ✓ | ✓ |

**The core use case is fully working:**
```ts
import { Database } from "bun:sqlite";
import { SQL } from "bun";

Database.setCustomSQLite("./vendor/libduckdb_sqlite_shim.dylib");

const sql = new SQL(":memory:");
const id = 2;
const rows = await sql`SELECT * FROM read_csv('data.csv') WHERE id = ${id}`;
```

---

## 🚧 In progress (started, needs finishing)

### 1. HUGEINT / DECIMAL precision
**Symptom:** `SELECT 170141...105727::HUGEINT` returns `0` (overflows `int64`).
**Fix started:** route `HUGEINT` / `UHUGEINT` / `DECIMAL` through `SQLITE_TEXT` so JS
gets the full decimal string instead of a truncated int. Type-map edit is written but
not yet rebuilt/verified.
**Goal:** no silent data loss for >2^63 integers or fixed-point decimals.

### 2. Named params `$x`
**Symptom:** `db.query("SELECT $x").get({ $x: 7 })` throws "Values were not provided".
**Root cause (investigated):** DuckDB's `duckdb_parameter_name()` returns names *without*
the `$` prefix (`foo`), but Bun's lookup expects the *full* token (`$foo`).
**Fix started:** cache prefixed names on the stmt struct; strip the prefix in
`bind_parameter_index`. Struct field added, logic incomplete.
**Note:** `$name` params are fixable. `:name` and `@name` are **not** (DuckDB's parser
rejects them outright).

### 3. LIST / STRUCT / nested types
**Symptom:** `SELECT [1,2,3]` returns `""` (empty string).
**Fix started:** route `LIST` / `STRUCT` / `MAP` / `ARRAY` / `UNION` through `SQLITE_TEXT`
so `duckdb_value_string` returns DuckDB's string representation (e.g. `[1, 2, 3]`,
`{'a': 1}`). Type-map edit written, not yet rebuilt.
**Goal:** something useful instead of empty; ideally valid JSON. (A stricter JSON
materialization would need a recursive walk of the data chunk — future work.)

---

## 📋 Next up (not started)

### 4. Transactions — `db.transaction()`
Bun's `transaction()` wrapper emits `SAVEPOINT \`name\`` with **backtick** identifiers,
which DuckDB rejects (it uses double-quotes). Two possible approaches:
- **SQL rewriting in `prepare`:** detect `SAVEPOINT`/`RELEASE` statements and rewrite
  backtick identifiers to double-quotes. Fragile but localized.
- **Document as unsupported** and let users write `BEGIN`/`COMMIT`/`ROLLBACK` by hand
  (those work fine — DuckDB supports them natively).

Priority: medium. Low risk to just document, since DuckDB supports explicit
`BEGIN`/`COMMIT`.

### 5. `sql.unsafe()` value-binding consistency
Verify `Bun.SQL`'s `sql.unsafe(sql, [values])` binds `?` params correctly in all the
same paths as `bun:sqlite`'s `.get()`/`.all()`/`.run()`. (The audit covers `bun:sqlite`
thoroughly; `Bun.SQL` needs its own coverage matrix.)

### 6. Safe-integers mode
When `bun:sqlite` opens with `safeIntegers: true`, Bun reads `sqlite3_column_int64` as a
JS `BigInt`. Confirm this round-trips for BIGINT (it should, since we pass through to
`duckdb_value_int64`). HUGEINT in this mode would still need the text route.

---

## 🚫 Fundamental limitations (cannot fix)

These are inherent to the DuckDB-vs-SQLite gap. They will never work through the shim.

| Limitation | Why |
|---|---|
| `:name` and `@name` params | DuckDB's SQL parser rejects them at parse time |
| Mixing named + positional in one statement | DuckDB v1.5.4 doesn't support it |
| `last_insert_rowid` | DuckDB has no `rowid` concept (returns `0`); use `RETURNING` |
| `serialize()` / `deserialize()` | No DuckDB equivalent; stubbed to error |
| `PRAGMA`, `sqlite_master`, SQLite built-in functions | Different SQL dialect |
| `AUTOINCREMENT` | DuckDB identity model differs |
| `db.loadExtension()` | Stubbed; no DuckDB equivalent (DuckDB has its own extension model) |

---

## ✅ Verified not-broken

Things that were worth confirming *do* work correctly end-to-end:
- `column_bytes` called before `column_text` (the order-independence bug we fixed early —
  per-column slot caching makes both calls trigger the fetch).
- UTF-16 string binding (`bind_text16`) — transcoded to UTF-8 for DuckDB.
- Multi-statement splitting (`find_stmt_end`) respects quotes/comments so `read_csv` paths
  containing `;` don't get mis-split.
- The `vendor/` build works from a clean clone (`scripts/build.sh`) on macOS/arm64.

---

## How to run the audit

```sh
make            # builds the shim into ./vendor
bun test/audit.ts   # prints the full ✓/✗ matrix
bun test/sql-tagged.ts   # the Bun.SQL end-to-end demo
```

When you close a gap, re-run `bun test/audit.ts` and flip its line in the matrix above.
