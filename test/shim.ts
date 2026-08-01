// setCustomSQLite can only be called once per process, so suites share this module.
import { Database } from "bun:sqlite";

Database.setCustomSQLite(import.meta.dir + "/../vendor/libduckdb_sqlite_shim.dylib");
