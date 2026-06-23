// libduckdb_sqlite_shim — exposes the SQLite C ABI (sqlite3_* symbols) backed by
// DuckDB's C API, so that Bun's `Database.setCustomSQLite("libduckdb_sqlite_shim.dylib")`
// drives a DuckDB engine instead of SQLite.
//
// Design:
//   - Bun dlopens this library and resolves a fixed set of sqlite3_* symbols via dlsym
//     (see bun/src/jsc/bindings/sqlite/lazy_sqlite3.h). Every symbol Bun looks up must
//     resolve, so they are all defined here: real translations where it matters, and
//     safe no-op stubs for SQLite features with no DuckDB equivalent.
//   - Bun treats sqlite3* / sqlite3_stmt* as opaque pointers, so we own their layout.
//   - Bun reads column count/name BEFORE stepping (SQLite allows this). DuckDB needs a
//     result for duckdb_column_*, but provides duckdb_prepared_statement_column_* for
//     pre-execute metadata — we use those for count/name and result-based accessors for
//     values/types.
//   - DuckDB's duckdb_value_string/_blob return memory the caller must duckdb_free;
//     SQLite's column_text returns stable-until-next-step memory. We bridge that with a
//     per-column "owned slot" freed on the next fetch / step / reset / finalize.
//   - sqlite3_step materializes the full result on the first call (duckdb_execute_prepared)
//     and then walks a row cursor, translating DuckDB success/error into SQLITE_ROW (100)
//     and SQLITE_DONE (101).
//
// Limitations (acceptable for the "basic query + get rows" scope):
//   - Results are materialized (not streamed).
//   - sqlite3_serialize/deserialize are stubbed (no DuckDB equivalent).
//   - sqlite3_file_control / load_extension are no-ops.
//   - SQL is DuckDB-flavored (Postgres-like), not SQLite-flavored. Plain
//     SELECT/INSERT/CREATE/transactions and `SELECT * FROM 'file.csv'` work; PRAGMAs and
//     sqlite_master do not.
//   - last_insert_rowid is always 0 (DuckDB has no rowid concept).

#include "duckdb.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// SQLite integer typedefs (normally from sqlite3.h, which we deliberately don't include).
typedef int64_t sqlite_int64;
typedef uint64_t sqlite_uint64;

// ---- SQLite result codes (only the ones we surface) ----
#define SQLITE_OK         0
#define SQLITE_ERROR      1   // generic error
#define SQLITE_ROW        100
#define SQLITE_DONE       101

// SQLite column type codes
#define SQLITE_INTEGER    1
#define SQLITE_FLOAT      2
#define SQLITE_TEXT       3
#define SQLITE_BLOB       4
#define SQLITE_NULL       5

// Bun passes this as the bind destructor ("make a private copy"); DuckDB's bind_*
// functions copy internally, so we ignore it. Only defined for completeness.
#define SQLITE_TRANSIENT  ((void (*)(void *))-1)

// ---- Opaque handle layouts (we own them; Bun never dereferences) ----
struct sqlite3 {
    duckdb_database db;
    duckdb_connection con;
    char *errmsg;            // malloc'd, most recent error on this connection
    int last_changes;        // rows changed by the most recent statement
    int total_changes;       // cumulative rows changed
};

// A per-column slot caching the most recently fetched TEXT/BLOB value, which DuckDB
// allocates and which we must free. Freed on next fetch for that column, on step,
// reset, and finalize.
struct slot {
    void *ptr;
    idx_t size;
};

struct sqlite3_stmt {
    duckdb_prepared_statement prep;
    duckdb_result result;
    int has_result;          // result holds a live query result
    int executed;            // first step has run duckdb_execute_prepared
    idx_t row;               // current row cursor (0-based)
    idx_t row_count;
    struct slot *slots;
    int nslots;
    char *sql;               // malloc'd copy of the prepared SQL (for expanded_sql)
    struct sqlite3 *db;      // owning connection, for changes bookkeeping
    // Cached parameter names (1-based). DuckDB returns them without the '$' prefix,
    // but SQLite's contract (and Bun's lookup) expects the prefix, so we prepend it.
    char **param_names;
};

// ---- helpers ----

static void set_err(struct sqlite3 *s, const char *msg)
{
    if (!s)
        return;
    free(s->errmsg);
    s->errmsg = msg ? strdup(msg) : NULL;
}

static void slots_clear(struct sqlite3_stmt *st)
{
    if (!st->slots)
        return;
    for (int i = 0; i < st->nslots; i++) {
        if (st->slots[i].ptr) {
            duckdb_free(st->slots[i].ptr);
            st->slots[i].ptr = NULL;
            st->slots[i].size = 0;
        }
    }
}

static void slots_ensure(struct sqlite3_stmt *st)
{
    if (st->slots)
        return;
    int n = (int)duckdb_prepared_statement_column_count(st->prep);
    if (n < 1)
        n = 1;
    st->slots = calloc((size_t)n, sizeof(struct slot));
    st->nslots = n;
}

// Find the byte offset just past the end of the first SQL statement in `sql`
// (i.e. one past the first top-level ';'), respecting single/double-quoted strings
// (with SQL ''/"" doubling), -- line comments, and /* */ block comments. Lets us feed
// DuckDB one statement at a time for multi-statement db.run(...).
static int find_stmt_end(const char *sql, int n)
{
    int i = 0;
    char quote = 0;
    int line_comment = 0, block_comment = 0;
    for (; i < n; i++) {
        char c = sql[i];
        if (quote) {
            if (c == quote) {
                if (i + 1 < n && sql[i + 1] == quote) {
                    i++; // doubled quote is a literal quote
                } else {
                    quote = 0;
                }
            }
            continue;
        }
        if (line_comment) {
            if (c == '\n')
                line_comment = 0;
            continue;
        }
        if (block_comment) {
            if (c == '*' && i + 1 < n && sql[i + 1] == '/') {
                block_comment = 0;
                i++;
            }
            continue;
        }
        if (c == '\'' || c == '"') {
            quote = c;
            continue;
        }
        if (c == '-' && i + 1 < n && sql[i + 1] == '-') {
            line_comment = 1;
            i++;
            continue;
        }
        if (c == '/' && i + 1 < n && sql[i + 1] == '*') {
            block_comment = 1;
            i++;
            continue;
        }
        if (c == ';')
            return i + 1;
    }
    return n;
}

// Transcode little-endian UTF-16 (JSC's in-memory representation on macOS) to a
// NUL-terminated UTF-8 malloc'd buffer. `n_bytes` is in bytes; returns bytes written
// (excluding NUL) via out_len.
static char *utf16le_to_utf8(const void *data, int n_bytes, size_t *out_len)
{
    const uint16_t *src = (const uint16_t *)data;
    int units = n_bytes / 2;
    char *buf = malloc((size_t)units * 4 + 1);
    if (!buf)
        return NULL;
    size_t j = 0;
    for (int i = 0; i < units;) {
        uint32_t cp = src[i++];
        if (cp >= 0xD800 && cp <= 0xDBFF && i < units) {
            uint32_t lo = src[i];
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                i++;
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
        }
        if (cp < 0x80) {
            buf[j++] = (char)cp;
        } else if (cp < 0x800) {
            buf[j++] = (char)(0xC0 | (cp >> 6));
            buf[j++] = (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            buf[j++] = (char)(0xE0 | (cp >> 12));
            buf[j++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            buf[j++] = (char)(0x80 | (cp & 0x3F));
        } else {
            buf[j++] = (char)(0xF0 | (cp >> 18));
            buf[j++] = (char)(0x80 | ((cp >> 12) & 0x3F));
            buf[j++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            buf[j++] = (char)(0x80 | (cp & 0x3F));
        }
    }
    buf[j] = 0;
    if (out_len)
        *out_len = j;
    return buf;
}

// ---- connection lifecycle ----

int sqlite3_open_v2(const char *filename, struct sqlite3 **out, int flags, const char *zVfs)
{
    (void)flags;
    (void)zVfs;
    if (out)
        *out = NULL;

    // DuckDB: NULL / empty / ":memory:" => in-memory instance.
    const char *path =
        (!filename || filename[0] == 0 || strcmp(filename, ":memory:") == 0) ? NULL : filename;

    duckdb_database db;
    char *err = NULL;
    if (duckdb_open_ext(path, &db, NULL, &err) == DuckDBError) {
        // Don't leak DuckDB's error message.
        if (err)
            duckdb_free(err);
        return SQLITE_ERROR;
    }

    duckdb_connection con;
    if (duckdb_connect(db, &con) == DuckDBError) {
        duckdb_close(&db);
        return SQLITE_ERROR;
    }

    struct sqlite3 *s = calloc(1, sizeof(struct sqlite3));
    s->db = db;
    s->con = con;
    if (out)
        *out = s;
    return SQLITE_OK;
}

static int close_common(struct sqlite3 *s)
{
    if (!s)
        return SQLITE_OK;
    if (s->con)
        duckdb_disconnect(&s->con);
    if (s->db)
        duckdb_close(&s->db);
    free(s->errmsg);
    free(s);
    return SQLITE_OK;
}

int sqlite3_close(struct sqlite3 *s) { return close_common(s); }
int sqlite3_close_v2(struct sqlite3 *s) { return close_common(s); }

// ---- error introspection ----

const char *sqlite3_errmsg(struct sqlite3 *s)
{
    if (s && s->errmsg)
        return s->errmsg;
    return "not an error";
}

int sqlite3_errcode(struct sqlite3 *s) { return (s && s->errmsg) ? SQLITE_ERROR : SQLITE_OK; }
int sqlite3_extended_errcode(struct sqlite3 *s) { return sqlite3_errcode(s); }
int sqlite3_error_offset(struct sqlite3 *s)
{
    (void)s;
    return -1; // SQLite: -1 means "no error offset available"
}

const char *sqlite3_errstr(int rc)
{
    switch (rc) {
    case SQLITE_OK:   return "not an error";
    case SQLITE_ROW:  return "row";
    case SQLITE_DONE: return "done";
    default:          return "DuckDB error via SQLite shim";
    }
}

// ---- prepare / finalize ----

int sqlite3_prepare_v3(struct sqlite3 *db, const char *sql, int nByte, unsigned int flags,
                       struct sqlite3_stmt **out, const char **pzTail)
{
    (void)flags;
    if (out)
        *out = NULL;
    if (!db || !sql)
        return SQLITE_ERROR;

    int len = nByte < 0 ? (int)strlen(sql) : nByte;
    int consumed = find_stmt_end(sql, len);

    char *sqlbuf = malloc((size_t)consumed + 1);
    if (!sqlbuf)
        return SQLITE_ERROR;
    memcpy(sqlbuf, sql, (size_t)consumed);
    sqlbuf[consumed] = 0;

    duckdb_prepared_statement prep;
    duckdb_state rc = duckdb_prepare(db->con, sqlbuf, &prep);
    if (rc == DuckDBError) {
        const char *e = duckdb_prepare_error(prep);
        set_err(db, e ? e : "prepare failed");
        duckdb_destroy_prepare(&prep);
        free(sqlbuf);
        // Even on failure, report the tail so a multi-statement run() can advance.
        if (pzTail)
            *pzTail = sql + consumed;
        return SQLITE_ERROR;
    }

    struct sqlite3_stmt *st = calloc(1, sizeof(struct sqlite3_stmt));
    st->prep = prep;
    st->sql = sqlbuf; // keep for expanded_sql
    st->db = db;

    if (out)
        *out = st;
    if (pzTail)
        *pzTail = sql + consumed;
    return SQLITE_OK;
}

// Bun never uses the UTF-16 prepare path, but the symbol must resolve.
int sqlite3_prepare16_v3(struct sqlite3 *db, const void *sql, int nByte, unsigned int flags,
                         struct sqlite3_stmt **out, const void **pzTail)
{
    size_t u8len = 0;
    char *u8 = utf16le_to_utf8(sql, nByte, &u8len);
    if (!u8) {
        if (out)
            *out = NULL;
        return SQLITE_ERROR;
    }
    const char *tail8 = NULL;
    int rc = sqlite3_prepare_v3(db, u8, (int)u8len, flags, out, pzTail ? &tail8 : NULL);
    // pzTail into the UTF-16 buffer isn't meaningful across encodings; report end.
    if (pzTail)
        *pzTail = (const char *)sql + nByte;
    free(u8);
    return rc;
}

int sqlite3_finalize(struct sqlite3_stmt *st)
{
    if (!st)
        return SQLITE_OK;
    slots_clear(st);
    free(st->slots);
    if (st->has_result)
        duckdb_destroy_result(&st->result);
    if (st->prep)
        duckdb_destroy_prepare(&st->prep);
    free(st->sql);
    free(st);
    return SQLITE_OK;
}

// ---- step ----

int sqlite3_step(struct sqlite3_stmt *s)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st)
        return SQLITE_ERROR;

    if (!st->executed) {
        // First step since prepare/reset: execute and materialize the result.
        slots_clear(st);
        if (st->has_result) {
            duckdb_destroy_result(&st->result);
            st->has_result = 0;
        }
        st->row = 0;

        duckdb_state rc = duckdb_execute_prepared(st->prep, &st->result);
        st->executed = 1;
        st->has_result = 1;
        if (rc == DuckDBError) {
            const char *e = duckdb_result_error(&st->result);
            set_err(st->db, e ? e : "execute failed");
            return SQLITE_ERROR;
        }
        st->row_count = duckdb_row_count(&st->result);

        // Bookkeeping for sqlite3_changes/total_changes.
        idx_t changed = duckdb_rows_changed(&st->result);
        st->db->last_changes = (int)changed;
        st->db->total_changes += (int)changed;

        if (st->row_count == 0)
            return SQLITE_DONE;
        return SQLITE_ROW;
    }

    // Subsequent step: advance the row cursor.
    slots_clear(st);
    st->row++;
    if (st->row < st->row_count)
        return SQLITE_ROW;
    return SQLITE_DONE;
}

int sqlite3_reset(struct sqlite3_stmt *s)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st)
        return SQLITE_OK;
    slots_clear(st);
    if (st->has_result) {
        duckdb_destroy_result(&st->result);
        st->has_result = 0;
    }
    st->executed = 0;
    st->row = 0;
    st->row_count = 0;
    return SQLITE_OK;
}

int sqlite3_clear_bindings(struct sqlite3_stmt *s)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (st)
        duckdb_clear_bindings(st->prep);
    return SQLITE_OK;
}

// ---- column metadata (valid before stepping, via prepared-statement API) ----

int sqlite3_column_count(struct sqlite3_stmt *s)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return st ? (int)duckdb_prepared_statement_column_count(st->prep) : 0;
}

const char *sqlite3_column_name(struct sqlite3_stmt *s, int N)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return st ? duckdb_prepared_statement_column_name(st->prep, (idx_t)N) : NULL;
}

const char *sqlite3_column_decltype(struct sqlite3_stmt *s, int N)
{
    (void)s;
    (void)N;
    return NULL; // not surfaced; Bun tolerates NULL
}

// ---- column values (result-based, valid after step) ----

int sqlite3_column_type(struct sqlite3_stmt *s, int i)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !st->has_result)
        return SQLITE_NULL;
    if (duckdb_value_is_null(&st->result, (idx_t)i, st->row))
        return SQLITE_NULL;
    duckdb_type t = duckdb_column_type(&st->result, (idx_t)i);
    switch (t) {
    case DUCKDB_TYPE_BOOLEAN:
    case DUCKDB_TYPE_TINYINT:
    case DUCKDB_TYPE_SMALLINT:
    case DUCKDB_TYPE_INTEGER:
    case DUCKDB_TYPE_BIGINT:
    case DUCKDB_TYPE_UTINYINT:
    case DUCKDB_TYPE_USMALLINT:
    case DUCKDB_TYPE_UINTEGER:
    case DUCKDB_TYPE_UBIGINT:
        return SQLITE_INTEGER;
    case DUCKDB_TYPE_FLOAT:
    case DUCKDB_TYPE_DOUBLE:
        return SQLITE_FLOAT;
    case DUCKDB_TYPE_BLOB:
        return SQLITE_BLOB;
    default:
        // Everything else is fetched as text via duckdb_value_string, which auto-casts.
        // This includes VARCHAR, timestamps, DECIMAL, HUGEINT, LIST, STRUCT, UUID, etc.
        // Routing HUGEINT/DECIMAL/LIST/STRUCT through TEXT prevents silent truncation
        // (HUGEINT overflows int64; complex types return empty if not stringified).
        return SQLITE_TEXT;
    }
}

int sqlite3_column_int(struct sqlite3_stmt *s, int i)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !st->has_result)
        return 0;
    return (int)duckdb_value_int64(&st->result, (idx_t)i, st->row);
}

sqlite_int64 sqlite3_column_int64(struct sqlite3_stmt *s, int i)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !st->has_result)
        return 0;
    return (sqlite_int64)duckdb_value_int64(&st->result, (idx_t)i, st->row);
}

double sqlite3_column_double(struct sqlite3_stmt *s, int i)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !st->has_result)
        return 0.0;
    return duckdb_value_double(&st->result, (idx_t)i, st->row);
}

// Lazily fetch and cache the TEXT value for column i in the current row. This makes
// column_text and column_bytes order-independent (SQLite's contract): Bun calls
// column_bytes BEFORE column_text, so bytes must trigger the fetch too. The cached slot
// (DuckDB-allocated) is freed on the next step/reset/finalize, not on re-fetch — within
// one row a column is fetched at most once.
static const unsigned char *ensure_text_slot(struct sqlite3_stmt *st, int i)
{
    if (!st || !st->has_result)
        return NULL;
    slots_ensure(st);
    if (i < 0 || i >= st->nslots)
        return NULL;
    if (st->slots[i].ptr)
        return (const unsigned char *)st->slots[i].ptr;
    duckdb_string str = duckdb_value_string(&st->result, (idx_t)i, st->row);
    st->slots[i].ptr = str.data;
    st->slots[i].size = str.size;
    return (const unsigned char *)str.data;
}

static const void *ensure_blob_slot(struct sqlite3_stmt *st, int i)
{
    if (!st || !st->has_result)
        return NULL;
    slots_ensure(st);
    if (i < 0 || i >= st->nslots)
        return NULL;
    if (st->slots[i].ptr)
        return st->slots[i].ptr;
    duckdb_blob blob = duckdb_value_blob(&st->result, (idx_t)i, st->row);
    st->slots[i].ptr = blob.data;
    st->slots[i].size = blob.size;
    return blob.data;
}

const unsigned char *sqlite3_column_text(struct sqlite3_stmt *s, int i)
{
    return ensure_text_slot((struct sqlite3_stmt *)s, i);
}

const void *sqlite3_column_blob(struct sqlite3_stmt *s, int i)
{
    return ensure_blob_slot((struct sqlite3_stmt *)s, i);
}

int sqlite3_column_bytes(struct sqlite3_stmt *s, int i)
{
    // Fetch via the matching slot so the size is correct regardless of call order.
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !st->has_result)
        return 0;
    if (st && st->has_result && i >= 0) {
        duckdb_type t = duckdb_column_type(&st->result, (idx_t)i);
        if (t == DUCKDB_TYPE_BLOB)
            ensure_blob_slot(st, i);
        else
            ensure_text_slot(st, i);
    }
    if (!st || i < 0 || i >= st->nslots)
        return 0;
    return (int)st->slots[i].size;
}

int sqlite3_column_bytes16(struct sqlite3_stmt *s, int i)
{
    return sqlite3_column_bytes(s, i);
}

// ---- parameter binding ----

int sqlite3_bind_parameter_count(struct sqlite3_stmt *s)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return st ? (int)duckdb_nparams(st->prep) : 0;
}

// Report NULL for purely numeric param names ("$1", "$2", ...) so Bun treats them as
// positional `?` parameters and binds by array index; named params are returned as-is
// (Bun strips the leading $/:/@ and looks the value up by name).
const char *sqlite3_bind_parameter_name(struct sqlite3_stmt *s, int i)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st)
        return NULL;
    const char *name = duckdb_parameter_name(st->prep, (idx_t)i);
    if (!name)
        return NULL;
    const char *p = name;
    if (*p == '$' || *p == ':' || *p == '@')
        p++;
    if (*p == 0)
        return NULL;
    for (const char *q = p; *q; q++) {
        if (*q < '0' || *q > '9')
            return name; // genuinely named
    }
    return NULL; // numeric => positional
}

int sqlite3_bind_parameter_index(struct sqlite3_stmt *s, const char *zName)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !zName)
        return 0;
    idx_t idx = 0;
    if (duckdb_bind_parameter_index(st->prep, &idx, zName) == DuckDBSuccess)
        return (int)idx;
    return 0;
}

int sqlite3_bind_int(struct sqlite3_stmt *s, int i, int v)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return duckdb_bind_int32(st->prep, (idx_t)i, v) == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

int sqlite3_bind_int64(struct sqlite3_stmt *s, int i, sqlite_int64 v)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return duckdb_bind_int64(st->prep, (idx_t)i, (int64_t)v) == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

int sqlite3_bind_double(struct sqlite3_stmt *s, int i, double v)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return duckdb_bind_double(st->prep, (idx_t)i, v) == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

int sqlite3_bind_null(struct sqlite3_stmt *s, int i)
{
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return duckdb_bind_null(st->prep, (idx_t)i) == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

int sqlite3_bind_text(struct sqlite3_stmt *s, int i, const char *zData, int n, void (*xDel)(void *))
{
    (void)xDel; // DuckDB copies; SQLITE_TRANSIENT is ignored.
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    int len = n < 0 ? (int)strlen(zData) : n;
    char *buf = malloc((size_t)len + 1);
    if (!buf)
        return SQLITE_ERROR;
    memcpy(buf, zData, (size_t)len);
    buf[len] = 0;
    duckdb_state rc = duckdb_bind_varchar(st->prep, (idx_t)i, buf);
    free(buf);
    return rc == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

int sqlite3_bind_text16(struct sqlite3_stmt *s, int i, const void *zData, int n, void (*xDel)(void *))
{
    (void)xDel;
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    char *u8 = utf16le_to_utf8(zData, n, NULL);
    if (!u8)
        return SQLITE_ERROR;
    duckdb_state rc = duckdb_bind_varchar(st->prep, (idx_t)i, u8);
    free(u8);
    return rc == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

int sqlite3_bind_blob(struct sqlite3_stmt *s, int i, const void *zData, int n, void (*xDel)(void *))
{
    (void)xDel;
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    return duckdb_bind_blob(st->prep, (idx_t)i, zData, (idx_t)n) == DuckDBSuccess ? SQLITE_OK : SQLITE_ERROR;
}

// ---- changes / bookkeeping ----

int sqlite3_changes(struct sqlite3 *s) { return s ? s->last_changes : 0; }
int sqlite3_total_changes(struct sqlite3 *s) { return s ? s->total_changes : 0; }
sqlite_int64 sqlite3_last_insert_rowid(struct sqlite3 *s)
{
    (void)s;
    return 0; // DuckDB has no rowid; use RETURNING instead.
}

// ---- diagnostic / introspection ----

int sqlite3_get_autocommit(struct sqlite3 *s)
{
    (void)s;
    return 1; // DuckDB connections autocommit by default.
}

int sqlite3_stmt_readonly(struct sqlite3_stmt *s)
{
    (void)s;
    return 0; // treat all as writable so Bun's changes-tracking path runs.
}

int sqlite3_stmt_busy(struct sqlite3_stmt *s)
{
    (void)s;
    return 0;
}

char *sqlite3_expanded_sql(struct sqlite3_stmt *s)
{
    // Bun frees this with sqlite3_free; return a libc malloc'd copy.
    struct sqlite3_stmt *st = (struct sqlite3_stmt *)s;
    if (!st || !st->sql)
        return NULL;
    return strdup(st->sql);
}

// ---- memory ----

void sqlite3_free(void *p) { free(p); }
void *sqlite3_malloc64(sqlite_uint64 n) { return malloc((size_t)n); }
int64_t sqlite3_memory_used(void) { return 0; }

// ---- version / compile options (stubbed) ----

const char *sqlite3_libversion(void) { return "3.45.0"; }
int sqlite3_compileoption_used(const char *zOptName)
{
    (void)zOptName;
    return 0;
}

// ---- configuration (stubbed to OK so Bun's init/open paths proceed) ----

int sqlite3_config(int op, ...)
{
    (void)op;
    return SQLITE_OK;
}

int sqlite3_db_config(struct sqlite3 *db, int op, ...)
{
    (void)db;
    (void)op;
    return SQLITE_OK;
}

int sqlite3_extended_result_codes(struct sqlite3 *db, int onoff)
{
    (void)db;
    (void)onoff;
    return SQLITE_OK;
}

// ---- unsupported features (no DuckDB equivalent) ----

int sqlite3_load_extension(struct sqlite3 *db, const char *zFile, const char *zProc, char **pzErrMsg)
{
    (void)db;
    (void)zFile;
    (void)zProc;
    if (pzErrMsg)
        *pzErrMsg = strdup("load_extension not supported by DuckDB shim");
    return SQLITE_ERROR;
}

int sqlite3_file_control(struct sqlite3 *db, const char *zDbName, int op, void *pArg)
{
    (void)db;
    (void)zDbName;
    (void)op;
    (void)pArg;
    return SQLITE_ERROR;
}

unsigned char *sqlite3_serialize(struct sqlite3 *db, const char *zSchema, sqlite_int64 *piSize, unsigned int mFlags)
{
    (void)db;
    (void)zSchema;
    (void)piSize;
    (void)mFlags;
    return NULL;
}

int sqlite3_deserialize(struct sqlite3 *db, const char *zSchema, unsigned char *pData,
                        sqlite_int64 szDb, sqlite_int64 szBuf, unsigned int mFlags)
{
    (void)db;
    (void)zSchema;
    (void)pData;
    (void)szDb;
    (void)szBuf;
    (void)mFlags;
    return SQLITE_ERROR;
}
