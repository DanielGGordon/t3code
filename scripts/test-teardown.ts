// Tear down a test-deploy slot.
//
//   node scripts/test-teardown.ts --port <ext>                 # stop + release claim; KEEP base-dir
//   node scripts/test-teardown.ts --port <ext> --purge         # also delete base-dirs/<ext>
//   node scripts/test-teardown.ts --branch t3code/foo          # resolve port from claim by branch
//   node scripts/test-teardown.ts --port <ext> --remove-worktree   # also git worktree remove (if clean)
//
// Base-dir is KEPT by default so re-reviewing the same branch keeps the user
// paired (30-day session). --purge only when the branch is abandoned/merged.

import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  assertNotProd,
  EXTERNAL_PORT_BASE,
  FORBIDDEN_EXTERNAL_PORT,
  isValidExternalPort,
  listClaimedPorts,
  loopbackForExternal,
  PROD_DIR,
  purgeBaseDir,
  SLOT_COUNT,
  readClaim,
  realProbe,
  realStopUnit,
  releaseClaim,
  runCapture,
  UNIT_NAME_PATTERN,
  unitForExternal,
  type Claim,
} from "./test-deploy-lib.ts";

function resolvePortFromBranch(branch: string): number {
  for (const externalPort of listClaimedPorts()) {
    const read = readClaim(externalPort);
    if (read.status === "ok" && read.claim.branch === branch) {
      return externalPort;
    }
  }
  throw new Error(`No claim found for branch ${branch}.`);
}

function removeWorktree(claim: Claim | null): void {
  if (!claim || claim.worktreePath.length === 0) {
    process.stderr.write(
      "[test-teardown] --remove-worktree: no worktree path on claim; skipping.\n",
    );
    return;
  }
  // Hard prod guard: a claim's worktreePath is trusted input (it can be wrong
  // via manual registry repair, an older buggy deploy, or a path-resolution
  // bypass). Never run `git worktree remove` against the prod checkout, even if
  // it happens to be clean. Deploy applies the same PROD_DIR guard before it
  // ever writes such a claim; enforce it again here at the destructive step.
  if (claim.worktreePath === PROD_DIR) {
    process.stderr.write(
      `[test-teardown] --remove-worktree: refusing to remove the prod checkout ${PROD_DIR}. ` +
        "This framework never touches prod. Skipping.\n",
    );
    return;
  }
  const status = runCapture("git", ["-C", claim.worktreePath, "status", "--porcelain"]);
  if (status.status !== 0) {
    process.stderr.write(
      `[test-teardown] --remove-worktree: cannot read git status at ${claim.worktreePath}; skipping.\n`,
    );
    return;
  }
  if (status.stdout.trim().length > 0) {
    process.stderr.write(
      `[test-teardown] --remove-worktree: worktree ${claim.worktreePath} is dirty; NOT removing.\n`,
    );
    return;
  }
  const commonDirResult = runCapture("git", [
    "-C",
    claim.worktreePath,
    "rev-parse",
    "--git-common-dir",
  ]);
  if (commonDirResult.status !== 0) {
    process.stderr.write(
      `[test-teardown] --remove-worktree: cannot resolve main repository for ${claim.worktreePath}; skipping.\n`,
    );
    return;
  }
  const mainRepo = NodePath.dirname(
    NodePath.resolve(claim.worktreePath, commonDirResult.stdout.trim()),
  );
  const removal = runCapture("git", ["-C", mainRepo, "worktree", "remove", claim.worktreePath]);
  if (removal.status !== 0) {
    process.stderr.write(`[test-teardown] git worktree remove failed: ${removal.stderr.trim()}\n`);
    return;
  }
  process.stdout.write(`[test-teardown] removed worktree ${claim.worktreePath}\n`);
}

function main(): void {
  const { values } = NodeUtil.parseArgs({
    options: {
      port: { type: "string" },
      branch: { type: "string" },
      purge: { type: "boolean", default: false },
      "remove-worktree": { type: "boolean", default: false },
    },
  });

  let externalPort: number;
  if (values.port !== undefined) {
    externalPort = Number.parseInt(values.port, 10);
  } else if (values.branch !== undefined) {
    externalPort = resolvePortFromBranch(values.branch);
  } else {
    throw new Error("Provide --port <ext> or --branch <name>.");
  }

  // Hard guards: never a prod target; only ports inside the managed pool; never
  // anything but a t3-test-*.service unit.
  if (externalPort === FORBIDDEN_EXTERNAL_PORT) {
    throw new Error(`Refusing --port ${FORBIDDEN_EXTERNAL_PORT}: that is prod.`);
  }
  if (!isValidExternalPort(externalPort)) {
    throw new Error(
      `Refusing --port ${externalPort}: outside the test-deploy pool ` +
        `(${EXTERNAL_PORT_BASE}..${EXTERNAL_PORT_BASE + SLOT_COUNT - 1}). ` +
        "This framework only manages its own pool slots.",
    );
  }
  const loopbackPort = loopbackForExternal(externalPort);
  const unit = unitForExternal(externalPort);
  assertNotProd(externalPort, loopbackPort, unit);
  if (!UNIT_NAME_PATTERN.test(unit)) {
    throw new Error(`Refusing to stop unit ${unit}: not a t3-test-*.service transient unit.`);
  }

  const read = readClaim(externalPort);
  const claim = read.status === "ok" ? read.claim : null;

  // Stop the transient unit (idempotent; ignores "not loaded").
  realStopUnit(unit);

  // Verify the stop actually took effect BEFORE releasing the claim. realStopUnit
  // swallows systemctl's exit code, so a failed stop (e.g. wedged unit) would
  // otherwise leave the server owning 127.0.0.1:<loopback> while we delete the
  // claim — status would show the slot free and the next deploy would claim the
  // same loopback port and collide with the survivor. If the unit is still
  // active, keep the claim so the slot stays visibly occupied and bail non-zero.
  if (realProbe.isUnitActive(unit)) {
    process.stderr.write(
      `[test-teardown] refusing to release slot ${externalPort}: ${unit} is still active after stop ` +
        `(systemctl stop appears to have failed). Leaving the claim in place so a later deploy does not ` +
        `collide on 127.0.0.1:${loopbackPort}. Investigate the unit and retry.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[test-teardown] stopped ${unit}\n`);

  // Release the claim.
  releaseClaim(externalPort);
  process.stdout.write(`[test-teardown] released claim for slot ${externalPort}\n`);

  if (values.purge) {
    purgeBaseDir(externalPort);
    process.stdout.write(
      `[test-teardown] purged base-dir for slot ${externalPort} (session dropped)\n`,
    );
  } else {
    process.stdout.write(
      `[test-teardown] KEPT base-dir for slot ${externalPort} (session preserved)\n`,
    );
  }

  if (values["remove-worktree"]) {
    removeWorktree(claim);
  }
}

main();
