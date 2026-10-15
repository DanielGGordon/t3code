import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// FORK MIGRATION (id 63, not an upstream number): every client address each
// auth session has connected from, so a connect from an address the session
// has never used can raise a security alert. Sessions that predate this table
// adopt their first recorded address silently (see SessionStore).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_session_client_ips (
      session_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (session_id, ip_address)
    )
  `;
});
