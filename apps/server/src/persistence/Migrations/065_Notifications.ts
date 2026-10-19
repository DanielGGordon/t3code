import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork migration: external notifications pushed over /api/notifications. Resolved rows are kept
// for 7 days so a late upsert from the source cannot reopen them, then pruned.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      body_trust TEXT NOT NULL,
      url TEXT,
      actions_json TEXT NOT NULL,
      callback_url TEXT,
      state TEXT NOT NULL,
      resolution TEXT,
      resolved_by TEXT,
      resolved_by_label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS notifications_state_expires_idx
    ON notifications (state, expires_at)
  `;
});
