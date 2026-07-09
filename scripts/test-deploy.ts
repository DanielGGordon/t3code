// Deploy the current worktree branch to a disposable local test instance.
//
//   node scripts/test-deploy.ts \
//     --pr https://github.com/DanielGGordon/t3code/pull/123 \
//     --note "short human description" \
//     [--seed minimal|copy|empty]
//
// Branch + worktree path are read from git. Binds 127.0.0.1 only (never
// --host 0.0.0.0); Caddy fronts the external HTTPS port. Never touches prod.

import { homedir } from "node:os";
import { parseArgs } from "node:util";

import {
  assertNotProd,
  buildPrCommentBody,
  claimSlot,
  ensureRegistry,
  ghCommentCommandLine,
  gitBranch,
  gitToplevel,
  loopbackForExternal,
  logPathFor,
  MISE_BIN,
  mintPairingLink,
  postPrComment,
  probeExternal,
  PROD_DIR,
  purgeBaseDir,
  readSeedManifest,
  realProbe,
  realStopUnit,
  releaseClaim,
  resolveSeedTemplate,
  runCapture,
  seedBaseDir,
  serverBinFor,
  spawnClaimHeartbeat,
  testUrlFor,
  unitForExternal,
  updateClaim,
  vpBinFor,
  worktreeMigrationCount,
  type Claim,
  type ResolvedTemplate,
  type SeedMode,
} from "./test-deploy-lib.ts";

function parseSeed(raw: string | undefined): SeedMode {
  if (raw === undefined) {
    return "curated";
  }
  if (raw === "curated" || raw === "minimal" || raw === "copy" || raw === "empty") {
    return raw;
  }
  throw new Error(`Invalid --seed ${raw}. Use curated (default), minimal, copy, or empty.`);
}

interface SeedDecision {
  readonly mode: SeedMode;
  /** Resolved template userdata dir when the effective mode is curated. */
  readonly templateUserdata: string | undefined;
  readonly template: ResolvedTemplate | null;
}

/**
 * Resolve the effective seed mode against the curated template's presence:
 *   - default (no --seed) + template present  → curated
 *   - default + no template                   → fall back to minimal (with note)
 *   - explicit --seed curated + no template   → hard error (unsatisfiable)
 *   - explicit minimal|copy|empty             → unchanged
 */
function decideSeed(requested: SeedMode, explicit: boolean): SeedDecision {
  const template = resolveSeedTemplate();
  if (requested !== "curated") {
    return { mode: requested, templateUserdata: undefined, template };
  }
  if (template !== null) {
    return { mode: "curated", templateUserdata: template.userdata, template };
  }
  if (explicit) {
    throw new Error(
      "Explicit --seed curated, but no curated seed template is present. " +
        "Build one first: node scripts/test-seed-refresh.ts",
    );
  }
  process.stdout.write(
    "[test-deploy] No curated seed template. Falling back to minimal. " +
      "Build one: node scripts/test-seed-refresh.ts\n",
  );
  return { mode: "minimal", templateUserdata: undefined, template: null };
}

/**
 * Surface template staleness at deploy time (no auto-refresh): age since build,
 * prod sha, DB schema, and a loud warning if the template's schema differs from
 * this worktree's migration count. Deploy still proceeds; the worktree server
 * migrates the seeded DB forward on boot (same as minimal's fresh DB).
 */
function printSeedStaleness(template: ResolvedTemplate, worktreePath: string): void {
  const manifest = readSeedManifest(template.dir);
  if (manifest === null) {
    process.stdout.write("[test-deploy] curated template present but manifest unreadable.\n");
    return;
  }
  const builtMs = Date.parse(manifest.builtAt);
  const ageStr = Number.isFinite(builtMs) ? formatAge(Date.now() - builtMs) : "unknown";
  process.stdout.write(
    `[test-deploy] curated template: age ${ageStr}, prodGitSha ${manifest.prodGitSha}, ` +
      `dbSchemaVersion ${manifest.dbSchemaVersion}\n`,
  );
  const branchSchema = worktreeMigrationCount(worktreePath);
  if (branchSchema > 0 && manifest.dbSchemaVersion !== branchSchema) {
    process.stdout.write(
      `[test-deploy] WARNING: template built at schema ${manifest.dbSchemaVersion}, this branch is at ` +
        `schema ${branchSchema} — rebuild if the DB layout changed (node scripts/test-seed-refresh.ts).\n`,
    );
  }
}

function formatAge(ms: number): string {
  if (ms < 0) {
    return "0m";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Positive-only listener probe for STARTUP detection. Unlike
 * realProbe.isPortListening — which biases to "listening" when `ss` errors, so
 * reclaim never evicts a possibly-live slot — startup/serve detection must only
 * report success on positive evidence. Any ss error yields `false` here (not yet
 * confirmed listening), so a probe failure can never be read as a healthy start.
 */
function isPortListeningStrict(loopbackPort: number): boolean {
  const result = runCapture("ss", ["-tlnH", `sport = :${loopbackPort}`]);
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.trim().length > 0;
}

/**
 * Wait until OUR transient unit is confirmed serving: the unit is active AND the
 * loopback port is listening. Requiring the unit to be active (not merely "some
 * process is on the port") means a pre-existing orphan on the loopback port — or
 * a probe error — is never mistaken for a healthy deploy of this instance.
 */
function waitForServing(unit: string, loopbackPort: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (realProbe.isUnitActive(unit) && isPortListeningStrict(loopbackPort)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    // Busy-wait with a cheap blocking sleep (no async runtime).
    runCapture("sleep", ["0.5"]);
  }
}

function readMainPid(unit: string): number | null {
  const result = runCapture("systemctl", ["--user", "show", unit, "-p", "MainPID", "--value"]);
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function startUnit(claim: Claim, seedMode: SeedMode): void {
  const logPath = logPathFor(claim.externalPort);
  const args = [
    "--user",
    `--unit=${claim.unit.replace(/\.service$/, "")}`,
    "--collect",
    `--working-directory=${claim.worktreePath}`,
    "--property=Restart=on-failure",
    "--property=RestartSec=3",
    // Persist stdout/stderr to the advertised per-slot log file (append so a
    // redeploy/restart does not clobber earlier output). journald still has it.
    `--property=StandardOutput=append:${logPath}`,
    `--property=StandardError=append:${logPath}`,
    // `%h` unit-file specifier expansion is NOT reliable on `systemd-run
    // --setenv=` command-line values (observed literal "%h" reaching the
    // process on systemd 255), which breaks any tool (e.g. mise) that
    // resolves paths under $HOME. Interpolate the real path instead.
    `--setenv=HOME=${homedir()}`,
    "--",
    MISE_BIN,
    "exec",
    "node@24",
    "--",
    "node",
    serverBinFor(claim.worktreePath),
    "serve",
    "--port",
    String(claim.loopbackPort),
    "--no-browser",
    "--base-dir",
    claim.baseDir,
  ];
  // NOTE: --host omitted on purpose => binds 127.0.0.1. Never pass 0.0.0.0.
  const result = runCapture("systemd-run", args);
  if (result.status !== 0) {
    throw new Error(`systemd-run failed to start ${claim.unit}: ${result.stderr.trim()}`);
  }
  process.stdout.write(`[test-deploy] started ${claim.unit} (seed=${seedMode}); log ${logPath}\n`);
}

interface Handoff {
  readonly claim: Claim;
  /** The display PR reference (real URL or a "open a PR" hint). */
  readonly prUrl: string;
  /** Ready-to-paste external pairing link (with token), or null in degraded mode. */
  readonly pairedUrl: string | null;
  /** Outcome of the mandatory PR comment step. */
  readonly comment: CommentOutcome;
}

type CommentOutcome =
  | { readonly kind: "posted" }
  | { readonly kind: "command"; readonly command: string; readonly reason: string }
  | { readonly kind: "no-pr" };

function printPrCommentSection(comment: CommentOutcome): void {
  process.stdout.write("\n---- MANDATORY: PR comment ----\n");
  switch (comment.kind) {
    case "posted":
      process.stdout.write(
        "Posted the test-deployment link as a PR comment (via `gh pr comment`).\n",
      );
      return;
    case "command":
      process.stdout.write(
        `PR comment NOT posted (${comment.reason}). This step is REQUIRED — run:\n\n  ${comment.command}\n`,
      );
      return;
    case "no-pr":
      process.stdout.write(
        "No --pr URL was supplied, so the PR comment could not be posted. Open the PR, then\n" +
          "post the test link with `gh pr comment <pr> --body ...` (see test-status --pair for a fresh link).\n",
      );
      return;
  }
}

function printHandoff(handoff: Handoff): void {
  const { claim, prUrl, pairedUrl, comment } = handoff;
  process.stdout.write("\n================ HANDOFF ================\n");

  if (pairedUrl === null) {
    // Degraded: external HTTPS path is not reachable, so there is NO usable
    // external URL to paste. The only working handoff is an SSH tunnel, and the
    // token must be minted against the tunnel origin (we do not know the user's
    // chosen local port yet). Do not print a token-less external URL as if live.
    process.stdout.write(
      "DEGRADED MODE: external HTTPS port not reachable (Caddy not bootstrapped or OVH port closed).\n" +
        "The instance is running on loopback only; the external URL is NOT reachable — do not paste it.\n" +
        "Hand the user an SSH tunnel and mint the pairing link against the tunnel origin:\n\n" +
        `  ssh -L 8080:127.0.0.1:${claim.loopbackPort} dgordon@15.204.108.12\n` +
        "  # THEN, inside that SSH session (on 15.204.108.12, not the laptop), run:\n" +
        `  node scripts/test-status.ts --pair ${claim.externalPort} --base-url http://127.0.0.1:8080\n` +
        "  # then open the printed http://127.0.0.1:8080/pair#token=... in the local browser\n\n" +
        `PR is here ${prUrl}.\n`,
    );
    printPrCommentSection(comment);
    process.stdout.write("========================================\n");
    return;
  }

  process.stdout.write(
    `Ok I finished that feature and pushed it to ${pairedUrl}. PR is here ${prUrl}. ` +
      "Try it out and let me know if it is good. If it is, I'll merge the PR to main and re-deploy prod.\n",
  );
  process.stdout.write(
    `\n(Pairing tokens last ~1h. Re-mint: node scripts/test-status.ts --pair ${claim.externalPort})\n`,
  );
  printPrCommentSection(comment);
  process.stdout.write("========================================\n");
}

function main(): void {
  const cwd = process.cwd();
  if (cwd === PROD_DIR) {
    throw new Error(`Refusing to run from the prod dir ${PROD_DIR}. Run from a feature worktree.`);
  }

  const { values } = parseArgs({
    options: {
      pr: { type: "string" },
      note: { type: "string" },
      seed: { type: "string" },
      // Post the mandatory test-deployment PR comment directly via `gh`.
      // Without it, test-deploy still prints a ready-to-run `gh pr comment …`.
      comment: { type: "boolean", default: false },
    },
  });

  const requestedSeed = parseSeed(values.seed);
  const seedExplicit = values.seed !== undefined;
  const prUrlArg = values.pr ?? null;
  const note = values.note ?? null;
  const postComment = values.comment === true;

  ensureRegistry();

  const branch = gitBranch(cwd);
  const worktreePath = gitToplevel(cwd);
  // Defense-in-depth: the cwd guard above only catches an exact match on
  // PROD_DIR, but the build runs in process.cwd() and the unit's
  // --working-directory is worktreePath = gitToplevel(cwd). Running from a
  // SUBDIRECTORY of the prod checkout has cwd !== PROD_DIR yet resolves the
  // toplevel to prod — which would build inside and serve the prod checkout.
  // Refuse whenever the git toplevel is prod, regardless of cwd depth.
  if (worktreePath === PROD_DIR) {
    throw new Error(
      `Refusing: git toplevel resolves to the prod checkout ${PROD_DIR}. Run from a feature worktree.`,
    );
  }
  // `t3code/<slug>` is the documented multi-agent convention, but not every
  // finished branch follows it (e.g. `fix/<slug>` from a single-agent worktree).
  // The only branch that must never be test-deployed is `main` itself — that
  // would be a prod-shaped deploy of the branch prod already tracks.
  if (branch === "main" || branch === "master") {
    throw new Error(
      `Refusing to test-deploy '${branch}': that is the prod branch, not a feature branch.`,
    );
  }

  // Resolve the effective seed mode against the curated template's presence, and
  // surface the template's staleness (age/sha/schema) before we take any slot.
  const seed = decideSeed(requestedSeed, seedExplicit);
  const seedMode = seed.mode;
  if (seedMode === "curated" && seed.template !== null) {
    printSeedStaleness(seed.template, worktreePath);
  }

  const {
    claim: initialClaim,
    reused,
    reclaimedFrom,
  } = claimSlot({
    branch,
    worktreePath,
    agentNote: note,
  });
  const externalPort = initialClaim.externalPort;
  const unit = initialClaim.unit;
  assertNotProd(externalPort, initialClaim.loopbackPort, unit);
  process.stdout.write(
    `[test-deploy] slot ${externalPort} (${reused ? "reused for branch" : reclaimedFrom !== null ? "reclaimed stale" : "fresh claim"}); loopback ${initialClaim.loopbackPort}\n`,
  );

  // Everything past the claim is wrapped so a failure releases the slot.
  try {
    // Only a same-branch redeploy (reused) may inherit the existing base-dir so
    // the user's paired 30-day session survives. A FRESH claim or a RECLAIMED
    // stale slot is a different branch reusing a recycled port; its leftover
    // userdata (DB/threads/settings + the prior branch's still-valid pairing)
    // must not bleed through. seedBaseDir keys only on userdata existence, so we
    // clear it here before seeding to keep the "fresh DB"/isolation promise.
    if (!reused) {
      purgeBaseDir(externalPort);
    }
    const seedResult = seedBaseDir(externalPort, seedMode, undefined, seed.templateUserdata);
    process.stdout.write(`[test-deploy] base-dir: ${seedResult}\n`);

    // Keep the claim's claimedAt fresh while the synchronous build blocks the
    // event loop, so a concurrent agent never sees this slot as stale mid-build.
    const stopHeartbeat = spawnClaimHeartbeat(externalPort);

    // Build the web dist in the worktree (server serves apps/web/dist). Resolve
    // vp's absolute worktree-local path rather than relying on PATH (see
    // vpBinFor) — a bare "vp" ENOENTs unless the caller's shell happens to have
    // this exact worktree's node_modules/.bin on PATH. The shim is executable
    // with its own shebang, so it is run directly (not via `node`).
    try {
      const build = runCapture(
        vpBinFor(worktreePath),
        ["run", "--filter", "@t3tools/web", "build"],
        {
          cwd: worktreePath,
        },
      );
      if (build.status !== 0) {
        throw new Error(`web build failed: ${build.stderr.trim() || build.stdout.trim()}`);
      }
    } finally {
      stopHeartbeat();
    }
    process.stdout.write("[test-deploy] web build ok\n");

    // Redeploy of a branch already holding this slot: the transient unit name is
    // the same, so `systemd-run --unit=<name>` would collide with the running
    // instance ("Unit already exists") and fail. Stop the old unit first (after
    // the build succeeds, so a build failure never takes down the live instance)
    // to refresh it in place with the newly built code.
    if (reused) {
      process.stdout.write(`[test-deploy] redeploy: stopping existing ${unit} before restart\n`);
      realStopUnit(unit);
    }

    // Guard: right before we start, nothing should own our loopback port. A
    // fresh/reclaimed slot must have a free port; a redeploy just stopped its old
    // unit. A listener here is either an orphan process or a failed stop — either
    // way, starting anyway would let waitForServing mistake that foreign listener
    // for our instance and hand off a URL for the wrong (or a dead) process.
    // Refuse loudly instead. (isPortListeningStrict biases to "free" on an ss
    // error, so a flaky probe never falsely blocks a legitimate start.)
    if (isPortListeningStrict(initialClaim.loopbackPort)) {
      throw new Error(
        `127.0.0.1:${initialClaim.loopbackPort} is already in use before starting ${unit}. ` +
          "An orphan process or a failed stop holds the port; refusing to start to avoid handing off " +
          "a link to the wrong instance. Investigate with `ss -tlnp` and `systemctl --user status`.",
      );
    }

    startUnit(initialClaim, seedMode);

    if (!waitForServing(unit, initialClaim.loopbackPort, 30_000)) {
      throw new Error(
        `${unit} did not come up serving on 127.0.0.1:${initialClaim.loopbackPort} within 30s ` +
          "(unit not active and/or port not listening).",
      );
    }
    process.stdout.write(
      `[test-deploy] ${unit} active and listening on 127.0.0.1:${initialClaim.loopbackPort}\n`,
    );

    const pid = readMainPid(unit);
    let claim = updateClaim(externalPort, { pid });
    if (prUrlArg) {
      claim = updateClaim(externalPort, { prUrl: prUrlArg });
    }

    const externalCode = probeExternal(externalPort);
    const degraded = externalCode === null;

    // Only mint a real (external) pairing link when the external path is live.
    // In degraded mode we cannot mint a usable link (the token is bound to the
    // tunnel origin the user has not opened yet), so pairedUrl stays null and
    // the handoff steers to the SSH-tunnel flow instead of a dead URL.
    let pairedUrl: string | null = null;
    if (degraded) {
      process.stdout.write(
        "[test-deploy] NOTE: external path unreachable; handing off in degraded (tunnel) mode.\n",
      );
    } else {
      pairedUrl = mintPairingLink({
        worktreePath,
        baseDir: claim.baseDir,
        baseUrl: testUrlFor(externalPort),
        ttl: "1h",
        label: `${unit} ${branch}`,
      });
    }

    // Mandatory PR-comment step (spec ADDENDUM): give the user a link from the
    // PR straight into the running instance. We always compute a ready-to-run
    // `gh pr comment …` command; with --comment we also post it directly.
    let comment: CommentOutcome;
    if (prUrlArg === null) {
      comment = { kind: "no-pr" };
    } else {
      const body = buildPrCommentBody({
        externalPort,
        loopbackPort: claim.loopbackPort,
        pairedUrl,
      });
      const command = ghCommentCommandLine(prUrlArg, body);
      if (postComment) {
        const posted = postPrComment(prUrlArg, body);
        comment = posted.ok
          ? { kind: "posted" }
          : { kind: "command", command, reason: `gh failed: ${posted.detail}` };
      } else {
        comment = { kind: "command", command, reason: "--comment not passed" };
      }
    }

    printHandoff({
      claim,
      prUrl: prUrlArg ?? "<open a PR: gh pr create --repo DanielGGordon/t3code --base main>",
      pairedUrl,
      comment,
    });
  } catch (error) {
    process.stderr.write(`[test-deploy] FAILED: ${(error as Error).message}\n`);
    if (reused) {
      // This slot was already owned by (and paired to) this branch. Do NOT
      // release the claim or delete the base-dir — that would strip the user's
      // paired session over a transient redeploy failure. The instance may be
      // down; re-running test-deploy reuses this same slot to retry.
      process.stderr.write(
        `[test-deploy] keeping slot ${externalPort} + base-dir (redeploy of an owned branch); re-run to retry.\n`,
      );
    } else {
      // Verify the stop actually took effect BEFORE releasing the claim, exactly
      // as test-teardown does. realStopUnit swallows systemctl's exit code, so a
      // failed/wedged stop would otherwise leave the server owning
      // 127.0.0.1:<loopback> while we delete the claim — status would then show
      // the slot free and the next deploy would claim the same loopback port and
      // collide with the survivor (or hand off the wrong instance). If the unit
      // is still active, KEEP the claim so the slot stays visibly occupied.
      realStopUnit(unit);
      if (realProbe.isUnitActive(unit)) {
        process.stderr.write(
          `[test-deploy] slot ${externalPort}: ${unit} still active after stop; KEEPING the claim to ` +
            `avoid a collision on 127.0.0.1:${loopbackForExternal(externalPort)}. ` +
            `Investigate the unit, then run: node scripts/test-teardown.ts --port ${externalPort}\n`,
        );
      } else {
        process.stderr.write(`[test-deploy] releasing slot ${externalPort} (keeping base-dir)\n`);
        releaseClaim(externalPort);
      }
    }
    process.exitCode = 1;
    return;
  }
}

main();
