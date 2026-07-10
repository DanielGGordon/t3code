// Shared logic for the local test-deployment framework.
//
// These scripts intentionally avoid the repo's Effect toolchain: they are
// dependency-free operational tooling meant to be invoked directly with
// `node scripts/<name>.ts` (Node 24 type-stripping). They talk to the host's
// systemd/user session, a filesystem registry, and git.
//
// EVERY entry point that computes or is handed a port/unit MUST call
// `assertNotProd` before taking any side effect. Prod is sacred:
//   - unit    t3code.service
//   - loopback 3773
//   - external 7443
//   - dir     /home/dgordon/projects/meta/t3code-v2
//   - userdata /home/dgordon/.t3/userdata

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Pool constants
// ---------------------------------------------------------------------------

export const HOST = process.env.T3_TEST_DEPLOY_HOST ?? "<SERVER_IP>";
export const SLOT_COUNT = 10;
export const EXTERNAL_PORT_BASE = 7444; // slots 0..9 -> 7444..7453
export const LOOPBACK_PORT_BASE = 3774; // slots 0..9 -> 3774..3783
/** loopback = external - PORT_DELTA (i.e. external = loopback + 3670). */
export const PORT_DELTA = EXTERNAL_PORT_BASE - LOOPBACK_PORT_BASE; // 3670

export const FORBIDDEN_EXTERNAL_PORT = 7443;
export const FORBIDDEN_LOOPBACK_PORT = 3773;
export const FORBIDDEN_UNIT = "t3code.service";

export const PROD_DIR = "/home/dgordon/projects/meta/t3code-v2";
export const PROD_USERDATA_DIR = join(homedir(), ".t3", "userdata");

export const UNIT_NAME_PATTERN = /^t3-test-\d+\.service$/;

export type SeedMode = "minimal" | "copy" | "empty" | "curated";

// ---------------------------------------------------------------------------
// Curated seed constants
// ---------------------------------------------------------------------------

/**
 * DB schema (`MAX(migration_id)` in `effect_sql_migrations`) the curated prune
 * list in `test-seed-refresh.ts` was authored against. The prune is schema-
 * coupled: every project_id/thread_id-keyed table must appear in `pruneCuratedDb`
 * because there are NO SQL foreign keys (`PRAGMA foreign_keys = 0`), so nothing
 * cascades. If a newer migration adds such a table, the refresh REFUSES rather
 * than silently orphaning rows — bump this constant AND extend the prune list
 * together, in lockstep.
 */
export const PRUNE_SCHEMA_VERSION = 32 as const;

/** Default number of most-recently-active projects kept in a curated template. */
export const SEED_DEFAULT_PROJECTS = 3;
/** Default number of most-recently-active threads kept per project ("a few"). */
export const SEED_DEFAULT_THREADS = 4;
/** Title prefix stamped onto every kept project/thread so a test instance is unmistakable. */
export const COPYOF_PREFIX = "COPYOF ";

/** Manifest schema version for `<template>/manifest.json` (not the DB schema). */
export const SEED_MANIFEST_SCHEMA_VERSION = 1 as const;

export function externalPorts(): number[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => EXTERNAL_PORT_BASE + i);
}

export function slotIndexForExternal(externalPort: number): number {
  return externalPort - EXTERNAL_PORT_BASE;
}

export function loopbackForExternal(externalPort: number): number {
  return externalPort - PORT_DELTA;
}

export function externalForLoopback(loopbackPort: number): number {
  return loopbackPort + PORT_DELTA;
}

export function unitForExternal(externalPort: number): string {
  return `t3-test-${externalPort}.service`;
}

export function testUrlFor(externalPort: number): string {
  return `https://${HOST}:${externalPort}`;
}

export function isValidExternalPort(externalPort: number): boolean {
  return (
    Number.isInteger(externalPort) &&
    externalPort >= EXTERNAL_PORT_BASE &&
    externalPort < EXTERNAL_PORT_BASE + SLOT_COUNT
  );
}

// ---------------------------------------------------------------------------
// Hard prod guard — throws before any side effect touches prod.
// ---------------------------------------------------------------------------

export class ForbiddenProdTargetError extends Error {
  constructor(detail: string) {
    super(`Refusing to act on a prod target: ${detail}. Prod is off-limits to this framework.`);
    this.name = "ForbiddenProdTargetError";
  }
}

export function assertNotProd(externalPort: number, loopbackPort: number, unit: string): void {
  if (externalPort === FORBIDDEN_EXTERNAL_PORT) {
    throw new ForbiddenProdTargetError(`external port ${FORBIDDEN_EXTERNAL_PORT}`);
  }
  if (loopbackPort === FORBIDDEN_LOOPBACK_PORT) {
    throw new ForbiddenProdTargetError(`loopback port ${FORBIDDEN_LOOPBACK_PORT}`);
  }
  if (unit === FORBIDDEN_UNIT) {
    throw new ForbiddenProdTargetError(`unit ${FORBIDDEN_UNIT}`);
  }
}

// ---------------------------------------------------------------------------
// Registry paths
// ---------------------------------------------------------------------------

export interface RegistryPaths {
  readonly root: string;
  readonly claims: string;
  readonly baseDirs: string;
  readonly logs: string;
  readonly lockDir: string;
  readonly bootstrapMarker: string;
  /** Symlink (never a real dir) → the currently-published curated seed version. */
  readonly seedTemplate: string;
  /** Real directory holding all built `<builtAt>` template versions. */
  readonly seedVersions: string;
  /** mkdir-lock serializing concurrent `test-seed-refresh` runs. */
  readonly seedRefreshLock: string;
}

export function registryRoot(): string {
  const override = process.env.T3_TEST_DEPLOY_HOME;
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), ".t3-test-deploy");
}

export function registryPaths(): RegistryPaths {
  const root = registryRoot();
  return {
    root,
    claims: join(root, "claims"),
    baseDirs: join(root, "base-dirs"),
    logs: join(root, "logs"),
    lockDir: join(root, ".lock"),
    bootstrapMarker: join(root, "caddy-bootstrapped"),
    seedTemplate: join(root, "seed-template"),
    seedVersions: join(root, "seed-versions"),
    seedRefreshLock: join(root, ".seed-refresh.lock"),
  };
}

/** Idempotent bootstrap: create the registry tree with 0700 perms. */
export function ensureRegistry(): RegistryPaths {
  const paths = registryPaths();
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.claims, { recursive: true, mode: 0o700 });
  mkdirSync(paths.baseDirs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  // seed-versions holds the real (immutable) template builds; seed-template is a
  // symlink into it that we never mkdir here (it is atomically swapped by the
  // refresh script). Older frameworks predating curated seeds still bootstrap
  // cleanly — this only adds the versions dir.
  mkdirSync(paths.seedVersions, { recursive: true, mode: 0o700 });
  return paths;
}

export function claimPathFor(externalPort: number): string {
  return join(registryPaths().claims, `${externalPort}.json`);
}

export function baseDirFor(externalPort: number): string {
  return join(registryPaths().baseDirs, `${externalPort}`);
}

export function logPathFor(externalPort: number): string {
  return join(registryPaths().logs, `${externalPort}.log`);
}

export function isBootstrapped(): boolean {
  return existsSync(registryPaths().bootstrapMarker);
}

// ---------------------------------------------------------------------------
// Claim model
// ---------------------------------------------------------------------------

export const CLAIM_SCHEMA_VERSION = 1 as const;

export interface Claim {
  readonly schemaVersion: 1;
  readonly externalPort: number;
  readonly loopbackPort: number;
  readonly testUrl: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseDir: string;
  readonly prUrl: string | null;
  readonly unit: string;
  readonly pid: number | null;
  readonly claimedAt: string;
  readonly agentNote: string | null;
}

export interface ClaimInput {
  readonly branch: string;
  readonly worktreePath: string;
  readonly agentNote?: string | null;
}

export function buildClaim(externalPort: number, input: ClaimInput): Claim {
  const loopbackPort = loopbackForExternal(externalPort);
  const unit = unitForExternal(externalPort);
  assertNotProd(externalPort, loopbackPort, unit);
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    externalPort,
    loopbackPort,
    testUrl: testUrlFor(externalPort),
    branch: input.branch,
    worktreePath: input.worktreePath,
    baseDir: baseDirFor(externalPort),
    prUrl: null,
    unit,
    pid: null,
    claimedAt: new Date().toISOString(),
    agentNote: input.agentNote ?? null,
  };
}

export type ClaimRead =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly claim: Claim }
  | { readonly status: "corrupt"; readonly raw: string };

export function readClaim(externalPort: number): ClaimRead {
  const path = claimPathFor(externalPort);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Claim;
    return { status: "ok", claim: parsed };
  } catch {
    return { status: "corrupt", raw };
  }
}

export function listClaimedPorts(): number[] {
  const dir = registryPaths().claims;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const ports: number[] = [];
  for (const entry of entries) {
    const match = /^(\d+)\.json$/.exec(entry);
    if (match && match[1] !== undefined) {
      const port = Number.parseInt(match[1], 10);
      if (isValidExternalPort(port)) {
        ports.push(port);
      }
    }
  }
  return ports.sort((a, b) => a - b);
}

/**
 * Atomic exclusive create of a claim file (O_CREAT | O_EXCL | O_WRONLY).
 * Returns true if we now own the slot; false if another agent already holds it.
 */
export function createClaimExclusive(claim: Claim): boolean {
  const path = claimPathFor(claim.externalPort);
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(claim, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Durable full rewrite of a claim (write-temp-then-rename). Single-writer. */
export function writeClaimAtomic(claim: Claim): void {
  const path = claimPathFor(claim.externalPort);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function updateClaim(
  externalPort: number,
  patch: Partial<Pick<Claim, "pid" | "prUrl" | "agentNote">>,
): Claim {
  const read = readClaim(externalPort);
  if (read.status !== "ok") {
    throw new Error(`Cannot update claim for port ${externalPort}: claim ${read.status}.`);
  }
  const updated: Claim = { ...read.claim, ...patch };
  writeClaimAtomic(updated);
  return updated;
}

export function releaseClaim(externalPort: number): void {
  try {
    unlinkSync(claimPathFor(externalPort));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// System probe (systemd + ss) — injectable for tests.
// ---------------------------------------------------------------------------

export interface SlotProbe {
  isUnitActive(unit: string): boolean;
  isPortListening(loopbackPort: number): boolean;
}

export function runCapture(
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string },
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    status: result.status ?? (result.error ? 127 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export const realProbe: SlotProbe = {
  isUnitActive(unit: string): boolean {
    // `systemctl --user is-active` prints a single ActiveState word. We only
    // treat a unit as NOT active when we have positive evidence it is dead
    // ("inactive"/"failed"/"deactivating"). "active"/"activating"/"reloading"
    // are alive — critically, "activating" covers the auto-restart (RestartSec)
    // window so a crash-looping-but-recovering instance is never seen as stale.
    // Anything else (empty output, "unknown", or a transient bus error that
    // yields no recognizable state) is UNCERTAIN and we bias to alive so we
    // never reclaim a slot out from under a live process on a flaky probe.
    const result = runCapture("systemctl", ["--user", "is-active", unit]);
    const state = result.stdout.trim();
    if (state === "inactive" || state === "failed" || state === "deactivating") {
      return false;
    }
    return true;
  },
  isPortListening(loopbackPort: number): boolean {
    // `ss` exits 0 with empty output when nothing is listening (the normal
    // "free" answer). A non-zero exit means ss itself errored (missing binary,
    // permission, etc.) — we cannot conclude the port is free, so we bias to
    // "listening" to keep reclaim from evicting a possibly-live slot.
    const result = runCapture("ss", ["-tlnH", `sport = :${loopbackPort}`]);
    if (result.status !== 0) {
      return true;
    }
    return result.stdout.trim().length > 0;
  },
};

/**
 * Build a minimal Claim describing a slot purely from its external port (unit,
 * loopback, base-dir all derived). Used when the on-disk claim is missing its
 * real fields (corrupt) but we still need to probe whether the slot's derived
 * unit/port are alive before declaring it stale/reclaimable.
 */
export function derivedClaimForPort(externalPort: number, branch = "<corrupt>"): Claim {
  const loopbackPort = loopbackForExternal(externalPort);
  const unit = unitForExternal(externalPort);
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    externalPort,
    loopbackPort,
    testUrl: testUrlFor(externalPort),
    branch,
    worktreePath: "",
    baseDir: baseDirFor(externalPort),
    prUrl: null,
    unit,
    pid: null,
    claimedAt: "",
    agentNote: null,
  };
}

export type SlotState = "alive" | "stale" | "free";

/**
 * Startup grace window. A slot's claim file is written (createClaimExclusive /
 * writeClaimAtomic) BEFORE test-deploy purges + seeds + runs the multi-minute
 * `vp run --filter @t3tools/web build` and only THEN calls systemd-run. During
 * that whole window the transient unit is not yet active and nothing is
 * listening on the loopback port — i.e. the raw "unit dead AND port free" test
 * reads as stale even though the slot is being actively deployed. Treating such
 * a slot as reclaimable lets a second agent double-claim the port and tear the
 * in-progress deploy out from under the first agent (and makes `test-status`
 * show a mid-build slot as `stale`, inviting a manual teardown). We therefore
 * protect any claim younger than this window: it is `alive` regardless of the
 * probe. The window must comfortably exceed a cold web build + startup; if a
 * deploy genuinely dies mid-build the slot self-heals to `stale` once the claim
 * ages past it.
 */
export const STARTUP_GRACE_MS = 15 * 60_000; // 15 minutes

/**
 * A claim is stale (reclaimable) only when its unit is NOT active AND nothing
 * else is listening on its loopback port AND it is older than the startup grace
 * window. If the unit is inactive but the port is still held by something, or
 * the claim is still inside its startup window, we treat it as alive and never
 * reclaim it out from under a live (or still-starting) process.
 */
export function computeSlotState(
  claim: Claim,
  probe: SlotProbe,
  now: number = Date.now(),
): "alive" | "stale" {
  if (probe.isUnitActive(claim.unit)) {
    return "alive";
  }
  if (probe.isPortListening(claim.loopbackPort)) {
    return "alive";
  }
  // Startup grace: never reclaim/flag a freshly-claimed slot whose unit has not
  // finished starting yet. A claim with no parseable timestamp (e.g. a derived
  // stand-in for a corrupt file) gets no grace — it falls through to stale.
  const claimedMs = Date.parse(claim.claimedAt);
  if (Number.isFinite(claimedMs) && now - claimedMs < STARTUP_GRACE_MS) {
    return "alive";
  }
  return "stale";
}

// ---------------------------------------------------------------------------
// Unit teardown (injectable)
// ---------------------------------------------------------------------------

export type StopUnitFn = (unit: string) => void;

export const realStopUnit: StopUnitFn = (unit: string): void => {
  // `--collect` transient units auto-GC, but stop + reset-failed is defensive.
  runCapture("systemctl", ["--user", "stop", unit]);
  runCapture("systemctl", ["--user", "reset-failed", unit]);
};

// ---------------------------------------------------------------------------
// Reclaim lock (mkdir-based, only on the pool-full path)
// ---------------------------------------------------------------------------

const RECLAIM_LOCK_STALE_MS = 60_000;

function lockHolderPidPath(lockDir: string): string {
  return join(lockDir, "holder");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire an mkdir-based lock at `lockDir`, force-breaking a stale one (old dir
 * or dead holder pid) and retrying once. Returns a release fn. Throws
 * `heldError` when a live holder still owns it after the break attempt. Shared
 * by the reclaim scan and the seed-refresh build so both get identical
 * stale-break semantics.
 */
export function acquireMkdirLock(lockDir: string, heldError: string): () => void {
  const tryMkdir = (): boolean => {
    try {
      mkdirSync(lockDir);
      writeFileSync(lockHolderPidPath(lockDir), String(process.pid));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  };

  if (tryMkdir()) {
    return () => releaseReclaimLock(lockDir);
  }

  // Existing lock — break it if stale (old dir or dead holder), then retry once.
  let shouldBreak = false;
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age > RECLAIM_LOCK_STALE_MS) {
      shouldBreak = true;
    } else {
      const holderRaw = existsSync(lockHolderPidPath(lockDir))
        ? readFileSync(lockHolderPidPath(lockDir), "utf8").trim()
        : "";
      const holderPid = Number.parseInt(holderRaw, 10);
      if (!Number.isInteger(holderPid) || !pidAlive(holderPid)) {
        shouldBreak = true;
      }
    }
  } catch {
    shouldBreak = true;
  }

  if (shouldBreak) {
    forceBreakLock(lockDir);
    if (tryMkdir()) {
      return () => releaseReclaimLock(lockDir);
    }
  }

  throw new Error(heldError);
}

/** Acquire the reclaim lock, force-breaking a stale one. Returns a release fn. */
export function acquireReclaimLock(): () => void {
  const { lockDir } = registryPaths();
  return acquireMkdirLock(
    lockDir,
    `Reclaim lock held by another agent (${lockDir}). Retry test-deploy shortly.`,
  );
}

/** Acquire the seed-refresh lock, serializing concurrent template builds. */
export function acquireSeedRefreshLock(): () => void {
  const { seedRefreshLock } = registryPaths();
  return acquireMkdirLock(
    seedRefreshLock,
    `Seed-refresh lock held by another agent (${seedRefreshLock}). Retry test-seed-refresh shortly.`,
  );
}

function forceBreakLock(lockDir: string): void {
  try {
    unlinkSync(lockHolderPidPath(lockDir));
  } catch {
    // ignore
  }
  try {
    rmdirSync(lockDir);
  } catch {
    // ignore
  }
}

function releaseReclaimLock(lockDir: string): void {
  forceBreakLock(lockDir);
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export class PoolExhaustedError extends Error {
  constructor() {
    super(
      "All 10 test-deploy slots are claimed and live. Run `node scripts/test-status.ts`, " +
        "reclaim a stale slot, or ask the user which live instance to tear down.",
    );
    this.name = "PoolExhaustedError";
  }
}

export interface ClaimResult {
  readonly claim: Claim;
  readonly reused: boolean;
  readonly reclaimedFrom: number | null;
}

export interface ClaimDeps {
  readonly probe: SlotProbe;
  readonly stopUnit: StopUnitFn;
}

const defaultClaimDeps: ClaimDeps = { probe: realProbe, stopUnit: realStopUnit };

/**
 * Claim a slot. Order of preference:
 *   1. Redeploy shortcut: an existing (live-or-stale) claim for the same branch
 *      is reused as-is (same port, same persisted base-dir → session preserved).
 *      The worktree path / note are refreshed in case the branch moved to a new
 *      worktree since the last deploy.
 *   2. Fast path: first free external port via atomic O_EXCL create.
 *   3. Reclaim path: under the mkdir lock, tear down a stale slot and atomically
 *      repurpose it for this branch (no free window between free and re-claim).
 */
export function claimSlot(input: ClaimInput, deps: ClaimDeps = defaultClaimDeps): ClaimResult {
  ensureRegistry();

  // 1. Redeploy shortcut.
  for (const port of listClaimedPorts()) {
    const read = readClaim(port);
    if (read.status === "ok" && read.claim.branch === input.branch) {
      // Re-derive all port-dependent fields from the filename-based external
      // port so that hand-edited or corrupted on-disk values (loopbackPort,
      // unit, baseDir, testUrl) never survive into the returned claim. Also
      // refresh worktreePath (may have moved) and bump claimedAt so the
      // startup grace window covers this redeploy's stop-old-unit →
      // start-new-unit gap.
      const loopbackPort = loopbackForExternal(port);
      const unit = unitForExternal(port);
      assertNotProd(port, loopbackPort, unit);
      const refreshed: Claim = {
        ...read.claim,
        externalPort: port,
        loopbackPort,
        testUrl: testUrlFor(port),
        unit,
        baseDir: baseDirFor(port),
        worktreePath: input.worktreePath,
        agentNote: input.agentNote ?? read.claim.agentNote,
        claimedAt: new Date().toISOString(),
      };
      writeClaimAtomic(refreshed);
      return { claim: refreshed, reused: true, reclaimedFrom: null };
    }
  }

  // 2. Fast path.
  for (const externalPort of externalPorts()) {
    const claim = buildClaim(externalPort, input);
    if (createClaimExclusive(claim)) {
      return { claim, reused: false, reclaimedFrom: null };
    }
  }

  // 3. Reclaim path.
  const reclaimed = reclaimStaleSlot(input, deps);
  if (reclaimed !== null) {
    return { claim: reclaimed.claim, reused: false, reclaimedFrom: reclaimed.reclaimedFrom };
  }

  throw new PoolExhaustedError();
}

export interface ReclaimResult {
  readonly claim: Claim;
  readonly reclaimedFrom: number;
}

/**
 * Find one stale slot under the reclaim lock and atomically repurpose it for
 * `input`, returning the new claim. Returns null if none are stale. Corrupt
 * claim files whose (filename-derived) unit is dead are reclaimed first; if no
 * cleanly stale slot exists, corrupt claims with live units are reclaimed as a
 * last resort (the metadata is already unrecoverable, so the slot would
 * otherwise stay permanently stuck).
 *
 * The freed slot is re-claimed WHILE STILL HOLDING THE LOCK, and the stale
 * claim file is overwritten in place (atomic rename) rather than unlinked and
 * re-created. That keeps the claim file present for the whole operation, so
 * neither a concurrent reclaimer (excluded by the lock) nor a concurrent
 * fast-path claimer (which only takes slots whose file is MISSING) can grab the
 * slot in a gap — closing the spurious-PoolExhausted race.
 */
export function reclaimStaleSlot(
  input: ClaimInput,
  deps: ClaimDeps = defaultClaimDeps,
): ReclaimResult | null {
  const release = acquireReclaimLock();
  try {
    const corruptAlivePorts: number[] = [];
    for (const externalPort of listClaimedPorts()) {
      const loopbackPort = loopbackForExternal(externalPort);
      const unit = unitForExternal(externalPort);
      assertNotProd(externalPort, loopbackPort, unit);

      const read = readClaim(externalPort);
      if (read.status === "missing") {
        continue;
      }

      if (read.status === "corrupt") {
        // Derive unit/port from the filename; reclaim immediately if truly dead.
        const derived = derivedClaimForPort(externalPort);
        if (computeSlotState(derived, deps.probe) === "stale") {
          deps.stopUnit(unit);
          const claim = buildClaim(externalPort, input);
          writeClaimAtomic(claim); // overwrite the corrupt file in place
          return { claim, reclaimedFrom: externalPort };
        }
        // Live unit but corrupt file — prefer a cleanly stale slot first.
        corruptAlivePorts.push(externalPort);
        continue;
      }

      // Override unit/loopbackPort with filename-derived values so probing
      // and stopping always target the slot's canonical unit, never an
      // unvalidated value from the JSON (which could name prod).
      const safeClaim: Claim = { ...read.claim, unit, loopbackPort, externalPort };
      if (computeSlotState(safeClaim, deps.probe) === "stale") {
        deps.stopUnit(unit);
        const claim = buildClaim(externalPort, input);
        writeClaimAtomic(claim); // overwrite the stale file in place
        return { claim, reclaimedFrom: externalPort };
      }
    }

    // No cleanly stale slot found. Reclaim the first corrupt+alive slot as a
    // last resort: the claim metadata is already unrecoverable, so the slot
    // cannot be matched to its original branch for redeploy. Without this,
    // the slot stays permanently stuck until manual registry repair.
    if (corruptAlivePorts.length > 0) {
      const externalPort = corruptAlivePorts[0]!;
      const unit = unitForExternal(externalPort);
      assertNotProd(externalPort, loopbackForExternal(externalPort), unit);
      process.stderr.write(
        `[test-deploy] WARN: reclaiming corrupt+alive slot ${externalPort} (stopping ${unit}).\n`,
      );
      deps.stopUnit(unit);
      const claim = buildClaim(externalPort, input);
      writeClaimAtomic(claim);
      return { claim, reclaimedFrom: externalPort };
    }

    return null;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Base-dir seeding
// ---------------------------------------------------------------------------

export type SeedResult =
  | "seeded-minimal"
  | "seeded-copy"
  | "seeded-empty"
  | "seeded-curated"
  | "kept-existing";

// ---------------------------------------------------------------------------
// Curated seed template: resolve + manifest (deploy-side read helpers)
// ---------------------------------------------------------------------------

export interface ResolvedTemplate {
  /** realpath of the published `seed-versions/<builtAt>` version dir. */
  readonly dir: string;
  /** `<dir>/userdata` — the drop-in copied into a slot's base-dir. */
  readonly userdata: string;
  readonly manifestPath: string;
}

/**
 * Resolve the currently-published curated template by following the
 * `seed-template` symlink to its real version dir. Returns null when the symlink
 * is missing, dangling, or points at a dir lacking `userdata/` (treated as "no
 * template" — the deploy then falls back to minimal). Always resolves either the
 * old complete version or the new complete one; the refresh publishes only via
 * an atomic symlink swap, so a half-built dir is never observable here.
 */
export function resolveSeedTemplate(): ResolvedTemplate | null {
  const { seedTemplate } = registryPaths();
  let real: string;
  try {
    // lstat confirms the entry exists (even as a dangling symlink); realpath then
    // follows it and throws on a dangling target — both caught as "no template".
    lstatSync(seedTemplate);
    real = realpathSync(seedTemplate);
  } catch {
    return null;
  }
  const userdata = join(real, "userdata");
  if (!existsSync(userdata)) {
    return null;
  }
  return { dir: real, userdata, manifestPath: join(real, "manifest.json") };
}

export interface SeedManifestKeptProject {
  readonly id: string;
  readonly title: string;
  readonly threads: number;
}

export interface SeedManifest {
  readonly schemaVersion: number;
  readonly builtAt: string;
  readonly prodDir: string;
  readonly prodGitSha: string;
  readonly dbSchemaVersion: number;
  readonly pruneSchemaVersion: number;
  readonly projects: number;
  readonly threadsPerProject: number;
  readonly keptProjects: readonly SeedManifestKeptProject[];
  readonly keptThreadIds: readonly string[];
  readonly prodDbBytes: number;
  readonly templateDbBytes: number;
  readonly sqliteLib: string;
}

/** Read + parse a template's manifest.json. Returns null if absent/corrupt. */
export function readSeedManifest(templateDir: string): SeedManifest | null {
  try {
    return JSON.parse(readFileSync(join(templateDir, "manifest.json"), "utf8")) as SeedManifest;
  } catch {
    return null;
  }
}

/**
 * Count the DB migration files in a worktree WITHOUT booting the server — the
 * code's schema version. Mirrors the on-disk convention: `NNN_*.ts` files under
 * apps/server/src/persistence/Migrations, excluding `*.test.ts`.
 */
export function worktreeMigrationCount(worktreePath: string): number {
  const dir = join(worktreePath, "apps", "server", "src", "persistence", "Migrations");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  return entries.filter((e) => /^\d{3}_.*\.ts$/.test(e) && !e.endsWith(".test.ts")).length;
}

// ---------------------------------------------------------------------------
// Attachment thread-segment derivation (ported from apps/server attachmentStore
// + attachmentPaths so the refresh script stays free of the Effect toolchain).
// A unit test asserts parity with the server helpers on <uuid> + claude-import
// samples; keep these in lockstep if the server derivation ever changes.
// ---------------------------------------------------------------------------

const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

/** Derive the filesystem-safe attachment segment for a thread id (server parity). */
export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  return segment.length === 0 ? null : segment;
}

/**
 * Recover the thread segment from an attachment file name (`<segment>-<uuid>.<ext>`),
 * or null if the name is not a well-formed attachment id. Combines the server's
 * `parseAttachmentIdFromRelativePath` (strip a single extension) with
 * `parseThreadSegmentFromAttachmentId` (match segment+uuid).
 */
export function attachmentFileThreadSegment(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const id = fileName.slice(0, dot);
  if (id.length === 0 || id.includes(".") || id.includes("/") || id.includes("\\")) {
    return null;
  }
  const match = ATTACHMENT_ID_PATTERN.exec(id);
  return match ? (match[1]?.toLowerCase() ?? null) : null;
}

/**
 * Seed (or preserve) the isolated --base-dir for a slot.
 *
 * If base-dirs/<ext>/userdata already exists (redeploy), it is left untouched so
 * the user's paired 30-day session survives. Otherwise it is created per `mode`:
 *   - curated (default): copy the pre-built curated template's inert userdata
 *                        (VACUUMed static DB + settings/secrets/pruned attachments)
 *                        wholesale. All the dangerous/expensive live-DB work
 *                        happened once in test-seed-refresh; here it is a plain
 *                        cpSync of static files, so no prod DB is opened.
 *   - minimal: copy settings.json, keybindings.json, secrets/ from prod;
 *              fresh DB + fresh environment-id (server generates them).
 *   - copy: full clone of prod userdata (escape hatch, non-default).
 *   - empty: nothing copied (escape hatch, non-default).
 *
 * `templateUserdata` is resolved by the caller (test-deploy resolves it once and
 * decides the fallback matrix); when omitted it is resolved here.
 */
export function seedBaseDir(
  externalPort: number,
  mode: SeedMode,
  prodUserdataDir: string = PROD_USERDATA_DIR,
  templateUserdata?: string,
): SeedResult {
  const baseDir = baseDirFor(externalPort);
  const userdata = join(baseDir, "userdata");

  if (existsSync(userdata)) {
    return "kept-existing";
  }

  mkdirSync(userdata, { recursive: true, mode: 0o700 });

  if (mode === "empty") {
    return "seeded-empty";
  }

  if (mode === "curated") {
    // Copy the static, already-curated template (no prod DB is opened here). The
    // template DB is a VACUUMed single file, so a plain recursive cpSync is safe
    // (unlike `copy` mode's live-prod-DB clone). The server regenerates a fresh
    // environment-id / server-runtime.json on boot (absent from the template).
    const resolved = templateUserdata ?? resolveSeedTemplate()?.userdata;
    if (resolved === undefined || !existsSync(resolved)) {
      throw new Error(
        "curated seed requested but no curated template is present. " +
          "Build one: node scripts/test-seed-refresh.ts",
      );
    }
    try {
      cpSync(resolved, userdata, { recursive: true });
    } catch (error) {
      // A concurrent `test-seed-refresh` GC keeps only the newest 2 version dirs;
      // if two refreshes publish while this copy is mid-flight, the version we
      // resolved can be deleted out from under cpSync (ENOENT). The newly-published
      // template is complete and equally valid, so re-resolve the live symlink and
      // retry the copy once against it rather than failing the deploy.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      rmSync(userdata, { recursive: true, force: true });
      mkdirSync(userdata, { recursive: true, mode: 0o700 });
      const retry = resolveSeedTemplate()?.userdata;
      if (retry === undefined || !existsSync(retry)) {
        throw error;
      }
      cpSync(retry, userdata, { recursive: true });
    }
    return "seeded-curated";
  }

  if (mode === "copy") {
    // Full clone of prod userdata into the isolated base-dir.
    cpSync(prodUserdataDir, userdata, { recursive: true });
    return "seeded-copy";
  }

  // minimal
  for (const file of ["settings.json", "keybindings.json"]) {
    const src = join(prodUserdataDir, file);
    if (existsSync(src)) {
      cpSync(src, join(userdata, file));
    }
  }
  const secretsSrc = join(prodUserdataDir, "secrets");
  if (existsSync(secretsSrc)) {
    cpSync(secretsSrc, join(userdata, "secrets"), { recursive: true });
  }
  return "seeded-minimal";
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

export function gitBranch(cwd: string): string {
  const result = runCapture("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) {
    throw new Error(`git rev-parse --abbrev-ref HEAD failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function gitToplevel(cwd: string): string {
  const result = runCapture("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.status !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Misc helpers used by CLIs
// ---------------------------------------------------------------------------

export function purgeBaseDir(externalPort: number): void {
  const baseDir = baseDirFor(externalPort);
  rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// t3 server invocation helpers (pairing, external probe)
// ---------------------------------------------------------------------------

export const MISE_BIN = "/home/dgordon/.local/bin/mise";

/** Absolute path to the worktree's server entrypoint. */
export function serverBinFor(worktreePath: string): string {
  return join(worktreePath, "apps", "server", "src", "bin.ts");
}

/**
 * Absolute path to the worktree-local `vp` (vite-plus) CLI. `vp` is only ever
 * installed into a project's own `node_modules/.bin` (never a global/mise bin),
 * so invoking it by bare name via `spawnSync` fails with ENOENT unless the
 * caller's shell happens to have that exact worktree's `node_modules/.bin` on
 * PATH — not a safe assumption for an agent-invoked script. Resolve the
 * absolute path instead, exactly like `serverBinFor`/`MISE_BIN` above.
 */
export function vpBinFor(worktreePath: string): string {
  return join(worktreePath, "node_modules", ".bin", "vp");
}

/**
 * Recover the WorkingDirectory of a systemd user unit. For transient units
 * started by `systemd-run --working-directory=<path>`, this is the worktree
 * path. Returns null when the unit is unknown or the property is empty.
 */
export function unitWorkingDirectory(unit: string): string | null {
  const result = runCapture("systemctl", [
    "--user",
    "show",
    unit,
    "-p",
    "WorkingDirectory",
    "--value",
  ]);
  const dir = result.stdout.trim();
  return result.status === 0 && dir.length > 0 ? dir : null;
}

export interface PairingRequest {
  readonly worktreePath: string;
  readonly baseDir: string;
  readonly baseUrl: string;
  readonly ttl: string;
  readonly label: string;
}

/**
 * Mint a one-time pairing link against a slot's --base-dir. Returns the full
 * `<baseUrl>/pair#token=<credential>` URL. Runs the server CLI under mise's
 * node@24, exactly like prod.
 */
export function mintPairingLink(req: PairingRequest): string {
  const result = runCapture(MISE_BIN, [
    "exec",
    "node@24",
    "--",
    "node",
    serverBinFor(req.worktreePath),
    "auth",
    "pairing",
    "create",
    "--base-dir",
    req.baseDir,
    "--base-url",
    req.baseUrl,
    "--ttl",
    req.ttl,
    "--label",
    req.label,
    "--json",
  ]);
  if (result.status !== 0) {
    throw new Error(`auth pairing create failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return parsePairingUrl(result.stdout, req.baseUrl);
}

/** Extract the pairing URL from `auth pairing create --json` output. */
export function parsePairingUrl(stdout: string, baseUrl: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["url", "pairingUrl", "link"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const token = parsed["token"] ?? parsed["credential"];
    if (typeof token === "string" && token.length > 0) {
      return `${baseUrl}/pair#token=${token}`;
    }
  } catch {
    // Fall through to regex scan for a `/pair#token=` URL in plain output.
  }
  const match = /https?:\/\/\S*\/pair#token=\S+/.exec(trimmed);
  if (match) {
    return match[0];
  }
  throw new Error(`Could not parse a pairing URL from auth output:\n${trimmed}`);
}

// ---------------------------------------------------------------------------
// PR comment (mandatory handoff surface — spec ADDENDUM)
// ---------------------------------------------------------------------------

export interface PrCommentInput {
  readonly externalPort: number;
  readonly loopbackPort: number;
  /** Full `<baseUrl>/pair#token=…` link, or null in degraded (tunnel) mode. */
  readonly pairedUrl: string | null;
}

/**
 * Build the Markdown body posted to the PR so the user can jump from the PR
 * straight into the running test instance. Always includes how to re-mint a
 * fresh pairing link (the token in `pairedUrl` is single-use / ~1h TTL).
 */
export function buildPrCommentBody(input: PrCommentInput): string {
  const remint = `node scripts/test-status.ts --pair ${input.externalPort}`;
  if (input.pairedUrl === null) {
    // Degraded: no reachable external URL. Hand off the SSH-tunnel flow.
    return [
      "## Test deployment (degraded / tunnel mode)",
      "",
      "This branch is running on a local test instance, but the external HTTPS",
      "port is not reachable yet (Caddy not bootstrapped or OVH port closed), so",
      "there is no public URL. Reach it over an SSH tunnel:",
      "",
      "```bash",
      "# Open the tunnel from your laptop (keep this session open):",
      `ssh -L 8080:127.0.0.1:${input.loopbackPort} dgordon@${HOST}`,
      `# THEN, inside that SSH session (i.e. on ${HOST}, not your laptop),`,
      "# mint a link whose URL points at your tunnel origin:",
      `node scripts/test-status.ts --pair ${input.externalPort} --base-url http://127.0.0.1:8080`,
      "# finally open the printed http://127.0.0.1:8080/pair#token=... in your local browser",
      "```",
      "",
      `Slot: external ${input.externalPort} ⇄ loopback ${input.loopbackPort}.`,
    ].join("\n");
  }
  return [
    "## Test deployment",
    "",
    `**[Open the test instance](${input.pairedUrl})** — ${input.pairedUrl}`,
    "",
    "That link pairs you and logs you in on this port for 30 days. It is",
    "single-use and expires in ~1h. To mint a fresh pairing link:",
    "",
    "```bash",
    remint,
    "```",
  ].join("\n");
}

/** Argv for `gh pr comment <pr> --body <body>` (no shell quoting needed). */
export function ghCommentArgs(prUrl: string, body: string): string[] {
  return ["pr", "comment", prUrl, "--body", body];
}

/**
 * A copy-pasteable single-line `gh pr comment …` command (body single-quoted
 * for the shell). Printed in every handoff so posting the comment is trivial
 * even when `--comment` was not passed (or `gh` failed).
 */
export function ghCommentCommandLine(prUrl: string, body: string): string {
  const quoted = `'${body.replace(/'/g, "'\\''")}'`;
  return `gh pr comment ${prUrl} --body ${quoted}`;
}

/** Post the PR comment via the `gh` CLI. Returns true on success. */
export function postPrComment(prUrl: string, body: string): { ok: boolean; detail: string } {
  const result = runCapture("gh", ghCommentArgs(prUrl, body));
  if (result.status === 0) {
    return { ok: true, detail: result.stdout.trim() };
  }
  return {
    ok: false,
    detail: result.stderr.trim() || result.stdout.trim() || "gh exited non-zero",
  };
}

/**
 * Probe the external HTTPS surface for a slot. Returns the HTTP status code
 * string if Caddy proxies through, or null if the external path is unreachable
 * (connection refused / timeout / not yet bootstrapped).
 *
 * LIMITATION: this curls the box's own public IP from the box itself, so it can
 * only confirm that LOCAL Caddy is up and proxying — it CANNOT prove the OVH
 * network firewall is open to the outside (loopback→own-public-IP bypasses that
 * filter). Actual external reachability is asserted out-of-band by the operator:
 * the documented bootstrap opens inbound TCP 7444-7453 in the OVH panel BEFORE
 * `touch`-ing the `caddy-bootstrapped` marker (see test-deploy-caddy.ts). This
 * probe is therefore a Caddy-health check gated behind that operator assertion,
 * not an end-to-end firewall check.
 */
export function probeExternal(externalPort: number): string | null {
  if (!isBootstrapped()) {
    return null;
  }
  const result = runCapture("curl", [
    "-sko",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--max-time",
    "4",
    `${testUrlFor(externalPort)}/`,
  ]);
  const code = result.stdout.trim();
  if (result.status === 0 && /^\d{3}$/.test(code) && code !== "000") {
    return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claim heartbeat (keeps claimedAt fresh during long synchronous operations)
// ---------------------------------------------------------------------------

/**
 * Spawn a detached background process that periodically refreshes a claim's
 * `claimedAt` timestamp. Returns a stop function that kills the heartbeat.
 *
 * The web build runs under `spawnSync` which blocks the Node event loop, so
 * `setInterval` cannot fire in the main process. A detached child process
 * sidesteps that: it runs its own event loop independently, keeping the claim
 * fresh so `computeSlotState` never sees it as stale mid-build.
 *
 * The heartbeat self-terminates when its parent process is no longer alive,
 * preventing orphaned heartbeats from keeping `claimedAt` fresh indefinitely
 * after the parent dies (e.g. SIGKILL during the build). A PID sidecar file
 * (`<claim>.hb.pid`) is written for external cleanup as a fallback.
 */
export function spawnClaimHeartbeat(
  externalPort: number,
  intervalMs: number = 5 * 60_000,
): () => void {
  const claimPath = claimPathFor(externalPort);
  const parentPid = process.pid;
  const pidFile = heartbeatPidFile(externalPort);
  const script =
    `const fs=require("fs");` +
    `const p=${JSON.stringify(claimPath)};` +
    `const ppid=${parentPid};` +
    `const pf=${JSON.stringify(pidFile)};` +
    `function parentAlive(){try{process.kill(ppid,0);return true}catch(e){return e.code==="EPERM"}}` +
    `const iv=setInterval(()=>{` +
    `if(!parentAlive()){clearInterval(iv);try{fs.unlinkSync(pf)}catch{}process.exit(0)}` +
    `try{` +
    `const c=JSON.parse(fs.readFileSync(p,"utf8"));` +
    `c.claimedAt=new Date().toISOString();` +
    `const t=p+".hb."+process.pid;` +
    `fs.writeFileSync(t,JSON.stringify(c,null,2)+"\\n",{mode:384});` +
    `fs.renameSync(t,p)` +
    `}catch{}},${intervalMs})`;
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  try {
    writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  } catch {
    // Best effort.
  }
  return () => {
    try {
      child.kill();
    } catch {
      // Process may have already exited.
    }
    try {
      unlinkSync(pidFile);
    } catch {
      // Best effort.
    }
  };
}

/** Path to the heartbeat PID sidecar file for a slot. */
export function heartbeatPidFile(externalPort: number): string {
  return `${claimPathFor(externalPort)}.hb.pid`;
}
