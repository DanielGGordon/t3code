# Rollback runbook — 2026-07-27 upstream sync (Sidebar v2 / glass / Auto mode)

This sync merges upstream through `f4c394323` and applies two schema migrations.
Rolling **back** is possible but has one hard constraint, documented below.

## Before deploying

1. **Stop the second migrating process.** `t3-claude-import.timer` runs
   `t3 import sync` against the same `state.sqlite` from the same checkout every
   15 minutes, so it can apply migrations outside the approved restart:

   ```
   systemctl --user stop t3-claude-import.timer
   ```

2. **Back up the whole userdata directory, not just the database.**
   `settings.json` holds every provider instance (binary paths, home paths,
   custom models, accent colors) and is not in git. `serverSettings.ts` falls
   back to defaults on _any_ decode failure with only a log warning, so a
   settings problem presents as "all my providers reset themselves", not as an
   error.

   There is **no `sqlite3` CLI on this host** — use Node 24's built-in
   `node:sqlite` instead. `VACUUM INTO` is safe against a live WAL database and
   produces a consistent single-file snapshot:

   ```
   DEST=~/backups/t3-pre-sidebarv2-2026-07-27
   mkdir -p "$DEST"
   cp -a ~/.t3/userdata/settings.json ~/.t3/userdata/keybindings.json \
         ~/.t3/userdata/secrets "$DEST"/
   mise exec node@24 -- node -e "
     const {DatabaseSync}=require('node:sqlite');
     const db=new DatabaseSync(process.env.HOME+'/.t3/userdata/state.sqlite',{readOnly:true});
     db.exec(\"VACUUM INTO '\"+process.env.HOME+\"/backups/t3-pre-sidebarv2-2026-07-27/state.sqlite'\");
   "
   ```

   Verify the snapshot before trusting it — read its ledger tail and thread count
   back and compare against the live database.

   Back up **outside** `userdata/`. A copy placed inside it gets swept into every
   later `--seed copy` test-deploy and every curated snapshot.

## After deploying

Verify the migration ledger advanced as expected — 33 is this fork's, 34 and 35
are upstream's renumbered pair:

```
mise exec node@24 -- node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.env.HOME+'/.t3/userdata/state.sqlite',{readOnly:true});
  console.log(db.prepare('SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 3').all());
"
```

Expect `35|ProjectionThreadsSnoozed`, `34|ProjectionThreadsSettled`,
`33|ProjectionThreadRestartRequest`.

Then confirm the columns exist and the live unit still matches the committed copy:

```
mise exec node@24 -- node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.env.HOME+'/.t3/userdata/state.sqlite',{readOnly:true});
  const cols=new Set(db.prepare('PRAGMA table_info(projection_threads)').all().map(c=>c.name));
  for (const c of ['requesting_restart','restart_request_reason','settled_override','settled_at','snoozed_until','snoozed_at'])
    console.log(cols.has(c)?'OK  ':'MISS', c);
"
diff <(systemctl --user cat t3code.service | tail -n +2) deploy/t3code.service
systemctl --user start t3-claude-import.timer
```

## Rolling back to a pre-merge build

The two new migrations are additive and `PRAGMA`-guarded, and the Migrator skips
any id `<=` the recorded max without comparing names, so an older build tolerates
the newer schema — the extra columns are simply ignored.

**The one-way door is the `auto` runtime mode.** Upstream adds `"auto"` to
`RuntimeMode`. `ProjectionThread.runtimeMode` is a bare closed union with no
decoding default, and `listThreadRows` is a `findAll` over every row — so a
_single_ thread persisted with `runtime_mode='auto'` makes the entire shell
snapshot fail to decode on a pre-merge build. The sidebar and thread list go
blank for every project, not just that thread.

This fork hides the Auto option behind Settings → Features
(`composerAutoRuntimeModeVisible`, default off) specifically to keep this door
open. If it was ever enabled, run this **before** redeploying an older build:

```
mise exec node@24 -- node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.env.HOME+'/.t3/userdata/state.sqlite');
  const r=db.prepare(\"UPDATE projection_threads SET runtime_mode='full-access' WHERE runtime_mode NOT IN ('approval-required','auto-accept-edits','full-access')\").run();
  console.log('rows normalized:', r.changes);
"
```

To roll the code back, force-push `main` to the pre-merge commit
(`77d79ff4a`) — do **not** `git revert -m 1` the merge. A revert leaves ancestry
claiming upstream is merged while the content is gone, so the next
`git merge upstream/main` would never restore the reverted files.
