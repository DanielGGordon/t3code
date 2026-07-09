# Local Test-Deployment Standard

When you finish a feature or bugfix on a `t3code/*` branch in a worktree, **do not merge to `main`.** Instead, deploy the branch to a disposable **local test instance** and hand it to the user for review. Prod stays untouched until the user approves the PR.

This is the full reference. `AGENTS.md` carries only a short pointer to this file.

## Hard rules (never violate)

1. **Never deploy a worktree branch to prod.** Prod = unit `t3code.service`, loopback `3773`, external `7443`, dir `/home/dgordon/projects/meta/t3code-v2`, userdata `/home/dgordon/.t3/userdata`. The scripts refuse these values (`assertNotProd`); do not work around the guard.
2. **Never restart `t3code.service` without explicit user approval in this conversation.** Restarting it can kill the very session you are running in.
3. **Always claim a port through the registry** (`~/.t3-test-deploy/`). Never bind a port by hand. Never pass `--host 0.0.0.0`; test instances bind `127.0.0.1` and are fronted by Caddy.
4. **Always teardown** after the PR is merged, or when the branch is abandoned. Leaving a slot claimed starves the pool.
5. **Always post the test-deployment link as a PR comment** once the branch is deployed (see below). The user must be able to jump from the PR straight into the running instance.

## The pool (10 fixed slots)

Each slot is one external HTTPS port fronted by Caddy plus one loopback port that `t3 serve` binds on `127.0.0.1`. Conversion: `loopback = external - 3670`.

| slot | external (Caddy TLS) | loopback (t3 serve) | test URL                   |
| ---- | -------------------- | ------------------- | -------------------------- |
| 0    | 7444                 | 3774                | https://15.204.108.12:7444 |
| 1    | 7445                 | 3775                | https://15.204.108.12:7445 |
| …    | …                    | …                   | …                          |
| 9    | 7453                 | 3783                | https://15.204.108.12:7453 |

**Hard-forbidden values (asserted in every script):** external `7443`, loopback `3773`, unit `t3code.service`.

## Do this when a feature is done

```bash
# from the feature worktree root, on a t3code/* branch:
vp check && vp run typecheck && vp test        # must be green first
git push -u origin t3code/<slug>
gh pr create --repo DanielGGordon/t3code --base main --head t3code/<slug> --fill
# --comment posts the mandatory test-link PR comment for you (gh must be authed):
node scripts/test-deploy.ts --pr <pr-url> --note "<short description>" --comment
```

`test-deploy` claims a free slot from the pool of 10 (external `7444–7453` ⇄ loopback `3774–3783`), seeds an isolated `--base-dir` (secrets + settings copied, fresh DB), builds `@t3tools/web`, starts a `t3-test-<port>.service` transient user unit on loopback, mints a `--ttl 1h` pairing link, posts the test link to the PR (with `--comment`), and prints the handoff message below.

If the branch already holds a slot (a redeploy after review fixes), `test-deploy` **reuses that slot and its persisted base-dir** — same port, same URL, rebuild + restart in place, session preserved, **no re-pair**. It never consumes a second slot for the same branch.

## Post the test link to the PR (mandatory)

After the branch is deployed, a comment containing the clickable test-deployment URL (and how to re-mint the pairing link) **must** be posted on the PR. Pass `--comment` to `test-deploy` to do this automatically; if you did not (or `gh` was not authenticated), `test-deploy` prints a ready-to-run `gh pr comment …` command in its handoff — run it.

The comment body (rendered on the PR) reads:

> ## Test deployment
>
> **[Open the test instance](https://15.204.108.12:<port>/pair#token=…)** — https://15.204.108.12:&lt;port&gt;/pair#token=…
>
> That link pairs you and logs you in on this port for 30 days. It is single-use and expires in ~1h. To mint a fresh pairing link: `node scripts/test-status.ts --pair <port>`

In degraded mode (external port not reachable) the comment instead contains the SSH-tunnel instructions and the `--base-url` re-mint command. Never skip this step: the PR must always carry a live path into the running instance.

## The handoff message (say exactly this, with the real URLs filled in)

> Ok I finished that feature and pushed it to `<test-url>`. PR is here `<pr-url>`. Try it out and let me know if it is good. If it is, I'll merge the PR to main and re-deploy prod.

`<test-url>` is the full `https://15.204.108.12:<port>/pair#token=…` link `test-deploy` printed. Pairing tokens last ~1 hour; after that (or after a purge), re-mint with `node scripts/test-status.ts --pair <port>`. Once the user pairs, they stay logged in on that port for 30 days — redeploying the same branch to the same slot keeps them paired.

## Other commands

```bash
node scripts/test-status.ts                 # who owns which slot; alive/stale/free
node scripts/test-status.ts --json          # same, machine-readable
node scripts/test-status.ts --pair <port>   # fresh pairing link for a slot
node scripts/test-status.ts --pair <port> --base-url http://127.0.0.1:8080  # tunnel origin
node scripts/test-status.ts --set-pr <url> --port <port>   # backfill the PR url on a claim
node scripts/test-teardown.ts --port <port> [--purge] [--remove-worktree]
node scripts/test-teardown.ts --branch t3code/<slug>       # resolve port from claim by branch
```

## The registry (`~/.t3-test-deploy/`)

Central source of truth, a sibling of prod's `~/.t3/` so it never collides with `~/.t3/userdata`. Overridable via `T3_TEST_DEPLOY_HOME` (used by the scripts' own tests against a throwaway path). Every script bootstraps it on first use.

```
~/.t3-test-deploy/
├── claims/                 # one JSON file per CLAIMED external port (e.g. 7444.json)
├── base-dirs/              # isolated --base-dir per slot (persists across redeploys)
│   └── 7444/userdata/...
├── logs/                   # per-slot stdout/stderr mirror (journal is primary)
├── seed-template           # symlink -> the active curated template version (atomic swap)
├── seed-versions/          # real curated template builds (<builtAt>/), newest 2 retained
├── .lock/                  # mkdir lock, present only during a stale-reclaim scan
├── .seed-refresh.lock/     # mkdir lock, present only during a curated template build
└── caddy-bootstrapped      # marker file (touch after the one-time Caddy bootstrap)
```

**Claiming is atomic.** A claim is an exclusive create (`O_CREAT | O_EXCL`) of `claims/<externalPort>.json`. Two agents racing for the same free port: the kernel guarantees exactly one wins; the loser advances to the next slot. No lock on the fast path.

**Staleness.** A claim is stale (reclaimable) only when its unit is not `active` **and** nothing is listening on its loopback port. `test-status` labels each slot `alive` / `stale` / `free`. A reboot leaves claims on disk but kills the transient units, so those slots show `stale` and are auto-reclaimable; base-dirs survive, so a redeploy re-pairs cleanly. Reclaiming a stale slot when the pool is full is serialized by the `mkdir` lock so two agents can't reclaim the same slot.

**Base-dir seeding** (`--seed`, default `curated`):

- `curated` (default): a small, safe copy of prod — ~3 projects with a few conversations each, every project name and thread title prefixed `COPYOF ` (e.g. "COPYOF t3code"). No prod sessions, pairing tokens, or provider resume state come along. Requires a template (build it with `test-seed-refresh`, below). If no template exists, deploys fall back to `minimal` and tell you to build one.
- `minimal`: copy `settings.json`, `keybindings.json`, and `secrets/` from prod userdata; start with a fresh empty DB and a fresh `environment-id` (the server generates them). Keeps the test surface clean and avoids importing prod threads/projects.
- `copy`: full clone of prod userdata (escape hatch, non-default, carries live data).
- `empty`: nothing copied (escape hatch, non-default).

Base-dirs persist across redeploys of the same slot, so the user's paired 30-day session survives a review-fix redeploy. Teardown **keeps** the base-dir by default; `--purge` drops it (use when the branch is abandoned/merged).

## Seeding a test instance

Every test deploy gets an isolated `--base-dir`. Choose what data it starts from with `--seed`:

- `curated` (default) — a small, safe copy of prod: ~3 projects with a few
  conversations each, every project name and thread title prefixed `COPYOF `
  (e.g. "COPYOF t3code"). No prod sessions, pairing tokens, or provider
  resume state come along. Requires a template (see below).
- `minimal` — settings + keybindings + secrets, empty DB.
- `copy` — full clone of prod userdata. Escape hatch; carries live data. Rare.
- `empty` — nothing.

### Build / refresh the curated template

    node scripts/test-seed-refresh.ts            # 3 projects, 4 threads each
    node scripts/test-seed-refresh.ts --projects 3 --threads 5

Reads prod **read-only** (WAL-safe online backup), prunes to the most recently
active projects/threads, prefixes titles with `COPYOF `, strips auth sessions,
pairing links, and all provider resume state, and **redirects every workspace to
an inert sandbox** (`~/.t3-test-deploy/curated-sandbox`) so a copied thread can
never spawn a coding agent against the user's real repos, then publishes
atomically to `~/.t3-test-deploy/seed-template`. Rerun any time to rebuild from
current prod. The `COPYOF ` marker and the sandbox redirect are written to both
the projection rows and the source events, so they survive even if the test
worktree rebuilds projections.

Optional size knobs (off by default): `--prefer-imported` biases the thread pick
toward small `claude-import-*` chats; `--max-events-per-thread K` drops threads
whose event count exceeds `K` (a live coding thread is 5-10× an imported chat).

Deploy prints the template's age and schema at each run. It never auto-refreshes
— rebuild it yourself when prod has changed or the DB schema has moved. If no
template exists, deploys fall back to `minimal` and tell you to build one.

Never modifies prod. The template is the only thing that touches prod data, and
only for reading. The build snapshots prod with a read-only online backup and
does every DELETE/UPDATE/VACUUM on the copy; it publishes via an atomic symlink
swap and retains the newest two builds under `~/.t3-test-deploy/seed-versions/`.

## Pairing UX

The one-time token is single-use and short-lived; `test-deploy` mints it with `--ttl 1h`. The URL is `<baseUrl>/pair#token=<credential>`; consuming it mints a **30-day per-origin bearer session**. Because each slot is a distinct `host:port` origin, the user pairs **once per test port**. If the token expires before they click (or after a `--purge` teardown), re-mint:

```bash
node scripts/test-status.ts --pair <port>
```

**Degraded mode** (external port not reachable — Caddy not bootstrapped or OVH port closed): the instance still runs on loopback. The handoff and PR comment give an SSH tunnel plus a re-mint bound to the tunnel origin:

```bash
ssh -L 8080:127.0.0.1:<loopbackPort> dgordon@15.204.108.12
# then, inside that SSH session (on 15.204.108.12), mint a link for the tunnel origin:
node scripts/test-status.ts --pair <port> --base-url http://127.0.0.1:8080
# open the printed http://127.0.0.1:8080/pair#token=... in your local browser
```

## If the port pool is exhausted

All 10 slots claimed → run `node scripts/test-status.ts`, reclaim any slot marked **stale** (dead unit / post-reboot): `node scripts/test-teardown.ts --port <staleport>`, then retry `test-deploy` (it auto-reclaims stale slots first). If every slot is genuinely **alive**, **stop and ask the user** which test instance to tear down — never evict a live instance on your own.

## PR flow

- **Branch naming:** `t3code/<slug>` (existing multi-agent convention).
- **PR base:** `main` on `origin` = `DanielGGordon/t3code`.

```bash
gh pr create --repo DanielGGordon/t3code --base main --head t3code/<slug> --fill
```

- **PR body convention:**

  ```
  ## Summary
  <what changed, why>

  ## Test plan
  - Deployed to local test instance: <test-url>
  - `vp check`, `vp run typecheck`, `vp test` all green

  ## Notes
  <risk / follow-ups>
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

Until `test-deploy` can open the PR for you (needs `gh` authenticated), it still works end-to-end; it just prints the exact `gh pr create …` command and stores `prUrl: null` in the claim (backfill later with `test-status --set-pr <url> --port <port>`).

## After the user approves (and only then)

```bash
gh pr merge <pr> --repo DanielGGordon/t3code --squash --delete-branch
git -C /home/dgordon/projects/meta/t3code-v2 fetch origin
git -C /home/dgordon/projects/meta/t3code-v2 checkout main
git -C /home/dgordon/projects/meta/t3code-v2 pull --ff-only origin main
( cd /home/dgordon/projects/meta/t3code-v2 && vp run --filter @t3tools/web build )
# restart prod ONLY if server code changed AND the user says so:
#   systemctl --user restart t3code.service
node scripts/test-teardown.ts --port <port> --purge --remove-worktree
```

Web-only changes never restart prod — the rebuilt `apps/web/dist` is served per-request. Restarting `t3code.service` restarts your own host process context if you run inside it, so always confirm with the user and expect the command to interrupt the session.

## First-time setup (once per box, needs the user)

External URLs require a one-time, user-approved privileged step (the single sanctioned prod-Caddy change), plus a user-local `gh`.

### 1. Caddy bootstrap (external exposure)

`scripts/test-deploy-caddy.ts` prints 10 additive `reverse_proxy` blocks (external `7444–7453` → loopback `3774–3783`), reusing the existing self-signed cert pair shared across the prod blocks. It only prints; appending and reloading is the privileged step:

```bash
# 1. Preview the blocks
node scripts/test-deploy-caddy.ts

# 2. Back up, append, validate, reload (passwordless sudo on this box)
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%s)
node scripts/test-deploy-caddy.ts | sudo tee -a /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

# 3. In the OVH control panel: open inbound TCP 7444-7453 (or confirm the cloud
#    firewall is disabled). Cannot be done from inside the VM.

# 4. VERIFY external reachability from OFF the box (do NOT skip — see note below).
#    From your laptop / any external host, one open pool port should answer:
#      curl -sko /dev/null -w '%{http_code}\n' https://15.204.108.12:7444/
#    Expect an HTTP status (e.g. 200/302/404), NOT a connection timeout/refused.

# 5. Mark the framework as externally-enabled
touch ~/.t3-test-deploy/caddy-bootstrapped
```

> **Why step 4 matters (marker semantics):** `probeExternal` curls the box's own
> public IP _from the box_, so it only proves local Caddy is proxying — it
> **cannot** prove the OVH firewall is actually open to the outside (loopback →
> own-public-IP bypasses that filter). The `caddy-bootstrapped` marker is an
> operator assertion that inbound `7444–7453` is genuinely reachable. If you
> `touch` it without opening the firewall, `test-deploy` will mint and post an
> `https://15.204.108.12:<port>/pair` link that external users get
> connection-refused on. Run the step-4 external `curl` before creating the
> marker (and again if the OVH firewall ever changes).

Until this is done, `test-deploy` runs in **degraded mode** and hands off SSH-tunnel instructions instead of an `https://…` URL. This is non-destructive: the existing `7443/8443/9443` blocks are never touched; only the additive `7444–7453` blocks are appended.

### 2. `gh` install + auth (user-local, no sudo)

```bash
GH_VER=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep -oP '"tag_name": "v\K[^"]+')
cd /tmp && curl -fsSL -o gh.tgz \
  "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_amd64.tar.gz"
tar xzf gh.tgz && install -m755 "gh_${GH_VER}_linux_amd64/bin/gh" ~/.local/bin/gh
gh --version
gh auth login   # GitHub.com → SSH → existing key. The agent cannot auth for you.
```

The agent **cannot** authenticate `gh` non-interactively without a secret the user supplies. Until it is authenticated, `test-deploy` works end-to-end except it cannot open the PR or post the PR comment — it prints the exact commands to run.

## Edge cases

- **Two agents claim simultaneously:** `O_EXCL` guarantees exactly one wins; the loser gets `EEXIST` and advances. No lock on the fast path.
- **Deploy fails mid-way:** everything after the claim is wrapped so a throw releases the slot (stop the half-started unit, delete the claim) — unless the slot was a same-branch redeploy already paired to the user, in which case the claim + base-dir are kept so a retry re-pairs cleanly.
- **Box reboot:** transient units are gone; claims persist and show `stale`; auto-reclaimable. Base-dirs survive.
- **Registry corrupted/missing:** scripts re-bootstrap the tree. A claim file that fails to parse is treated as stale **only if its (filename-derived) unit is dead**; if the unit is live, the script warns and skips it — never silently deletes a claim whose unit is live.

## Non-goals

- No rewrites of prod Caddy config beyond the additive `7444–7453` blocks. No touching the `7443/8443/9443` blocks.
- No auto-merge of PRs. Merging happens only after explicit user approval.
- No prod restarts except the explicit, user-approved post-merge step; web-only changes never restart prod.
- No `--host 0.0.0.0` / direct internet binding for test instances (loopback + Caddy only).
- No modification of prod's `~/.t3/userdata` — test data lives entirely under `~/.t3-test-deploy/`.
