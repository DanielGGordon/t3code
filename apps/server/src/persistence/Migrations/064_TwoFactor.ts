import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork migration: environment-wide enrollment and per-session verification.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE auth_two_factor (
    id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL,
    last_step INTEGER NOT NULL DEFAULT -1
  )`;
  yield* sql`CREATE TABLE auth_two_factor_sessions (
    session_id TEXT PRIMARY KEY, verified_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE auth_two_factor_recovery (hash TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE auth_two_factor_attempts (
    id INTEGER PRIMARY KEY CHECK (id = 1), attempts INTEGER NOT NULL, window_start INTEGER NOT NULL
  )`;
});
