---
name: token
description: Issue a fresh one-time pairing token to log into this self-hosted T3 Code prod server (15.204.108.12:7443), without restarting the service or disrupting other sessions. Use when the user says "/token", asks for a new login/pairing token, or their pairing link expired or was already consumed. Only runs on the T3 deploy host.
---

# Issue a T3 Code login token (prod)

Issues a new single-use pairing token against the **live** prod database, without
touching `t3code.service`. The logic lives in `token.sh` next to this file; your job
is to run it and hand back the printed URL.

## What the script does

1. Guards that it's running on the actual T3 deploy host: checks the deploy checkout
   (`~/projects/meta/t3code-v2`), the `t3code.service` unit, and the live state dir
   (`~/.t3/userdata`) all exist.
2. Runs the server's `auth pairing create` CLI directly against `~/.t3` (the same data
   directory `t3code.service` is already serving from) with `T3CODE_PORT=3773`, so the
   token lands in the running server's live database — no restart needed.
3. Prints a ready-to-use `https://15.204.108.12:7443/pair#token=...` link.

Unlike `/redeploy`, this never touches the running service — no session drop.

## How to run

```bash
bash "$(git rev-parse --show-toplevel)/.claude/skills/token/token.sh" [ttl]
```

`ttl` is optional and defaults to `15m` (accepts anything the server understands, e.g.
`5m`, `1h`, `30d`).

## Handling the result

- Report the pair URL and its expiry to the user directly in chat.
- Treat it as a secret: don't put it in commit messages, screenshots, or any durable
  log — it's a single-use bearer credential. Opening it twice, or in two different
  browsers, consumes/invalidates it.
