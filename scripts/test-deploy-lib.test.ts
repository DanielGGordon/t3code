import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  assertNotProd,
  attachmentFileThreadSegment,
  baseDirFor,
  buildClaim,
  buildPrCommentBody,
  claimPathFor,
  claimSlot,
  computeSlotState,
  createClaimExclusive,
  derivedClaimForPort,
  ensureRegistry,
  externalForLoopback,
  externalPorts,
  ForbiddenProdTargetError,
  ghCommentArgs,
  ghCommentCommandLine,
  loopbackForExternal,
  parsePairingUrl,
  PoolExhaustedError,
  readClaim,
  readSeedManifest,
  registryPaths,
  releaseClaim,
  resolveSeedTemplate,
  seedBaseDir,
  STARTUP_GRACE_MS,
  testUrlFor,
  toSafeThreadAttachmentSegment,
  unitForExternal,
  updateClaim,
  worktreeMigrationCount,
  type ClaimDeps,
  type SlotProbe,
} from "./test-deploy-lib.ts";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3-test-deploy-"));
  process.env.T3_TEST_DEPLOY_HOME = home;
});

afterEach(() => {
  delete process.env.T3_TEST_DEPLOY_HOME;
  rmSync(home, { recursive: true, force: true });
});

const aliveProbe: SlotProbe = {
  isUnitActive: () => true,
  isPortListening: () => true,
};

function fakeDeps(overrides: Partial<SlotProbe>, stopped: string[]): ClaimDeps {
  return {
    probe: { ...aliveProbe, ...overrides },
    stopUnit: (unit) => {
      stopped.push(unit);
    },
  };
}

/** Rewrite a claim's on-disk claimedAt to `ageMs` in the past (past the grace). */
function ageClaim(externalPort: number, ageMs: number): void {
  const path = claimPathFor(externalPort);
  const claim = JSON.parse(readFileSync(path, "utf8")) as { claimedAt: string };
  claim.claimedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`);
}

describe("pool math + guards", () => {
  it("maps the 10 slots with a fixed 3670 delta", () => {
    assert.deepEqual(externalPorts(), [7444, 7445, 7446, 7447, 7448, 7449, 7450, 7451, 7452, 7453]);
    assert.equal(loopbackForExternal(7444), 3774);
    assert.equal(loopbackForExternal(7453), 3783);
    assert.equal(externalForLoopback(3774), 7444);
    assert.equal(unitForExternal(7444), "t3-test-7444.service");
    assert.equal(testUrlFor(7444), "https://15.204.108.12:7444");
  });

  it("assertNotProd throws on every forbidden target", () => {
    assert.throws(
      () => assertNotProd(7443, 3774, "t3-test-7444.service"),
      ForbiddenProdTargetError,
    );
    assert.throws(
      () => assertNotProd(7444, 3773, "t3-test-7444.service"),
      ForbiddenProdTargetError,
    );
    assert.throws(() => assertNotProd(7444, 3774, "t3code.service"), ForbiddenProdTargetError);
    // Valid slot does not throw.
    assertNotProd(7444, 3774, "t3-test-7444.service");
  });

  it("buildClaim refuses to describe a prod slot", () => {
    assert.throws(
      () => buildClaim(7443, { branch: "t3code/x", worktreePath: "/tmp/wt" }),
      ForbiddenProdTargetError,
    );
  });
});

describe("registry bootstrap + atomic claim", () => {
  it("creates the registry tree on demand", () => {
    ensureRegistry();
    assert.isTrue(existsSync(join(home, "claims")));
    assert.isTrue(existsSync(join(home, "base-dirs")));
    assert.isTrue(existsSync(join(home, "logs")));
  });

  it("atomically claims a slot and rejects a double-claim", () => {
    const claim = buildClaim(7444, { branch: "t3code/a", worktreePath: "/tmp/wt" });
    ensureRegistry();
    assert.isTrue(createClaimExclusive(claim));
    // Second exclusive create on the same slot must fail (O_EXCL).
    assert.isFalse(createClaimExclusive(claim));
    assert.isTrue(existsSync(claimPathFor(7444)));
  });

  it("release deletes the claim file and is idempotent", () => {
    const claim = buildClaim(7444, { branch: "t3code/a", worktreePath: "/tmp/wt" });
    ensureRegistry();
    createClaimExclusive(claim);
    releaseClaim(7444);
    assert.isFalse(existsSync(claimPathFor(7444)));
    releaseClaim(7444); // no throw on missing
  });

  it("updateClaim rewrites pid/prUrl durably", () => {
    ensureRegistry();
    createClaimExclusive(buildClaim(7444, { branch: "t3code/a", worktreePath: "/tmp/wt" }));
    updateClaim(7444, { pid: 4242, prUrl: "https://github.com/DanielGGordon/t3code/pull/9" });
    const read = readClaim(7444);
    assert.equal(read.status, "ok");
    if (read.status === "ok") {
      assert.equal(read.claim.pid, 4242);
      assert.equal(read.claim.prUrl, "https://github.com/DanielGGordon/t3code/pull/9");
    }
  });
});

describe("claimSlot behavior", () => {
  it("fast-path claims the lowest free slot", () => {
    const stopped: string[] = [];
    const result = claimSlot(
      { branch: "t3code/one", worktreePath: "/tmp/wt" },
      fakeDeps({}, stopped),
    );
    assert.equal(result.claim.externalPort, 7444);
    assert.isFalse(result.reused);
    assert.isNull(result.reclaimedFrom);
  });

  it("reuses the same slot for a redeploy of the same branch", () => {
    const stopped: string[] = [];
    const first = claimSlot(
      { branch: "t3code/dup", worktreePath: "/tmp/wt" },
      fakeDeps({}, stopped),
    );
    const second = claimSlot(
      { branch: "t3code/dup", worktreePath: "/tmp/wt" },
      fakeDeps({}, stopped),
    );
    assert.equal(second.claim.externalPort, first.claim.externalPort);
    assert.isTrue(second.reused);
  });

  it("throws PoolExhaustedError when all 10 slots are live", () => {
    const stopped: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      claimSlot({ branch: `t3code/b${i}`, worktreePath: "/tmp/wt" }, fakeDeps({}, stopped));
    }
    assert.throws(
      () =>
        claimSlot({ branch: "t3code/overflow", worktreePath: "/tmp/wt" }, fakeDeps({}, stopped)),
      PoolExhaustedError,
    );
  });

  it("reclaims a stale slot when the pool is full", () => {
    const stopped: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      claimSlot({ branch: `t3code/b${i}`, worktreePath: "/tmp/wt" }, fakeDeps({}, stopped));
    }
    // Mark slot 7448 dead: its unit is inactive and its loopback port is free.
    // Also AGE its claim past the startup grace window — a fresh claim (as just
    // written by claimSlot) is grace-protected and would not be reclaimable.
    ageClaim(7448, STARTUP_GRACE_MS + 60_000);
    const deadUnit = unitForExternal(7448);
    const deadLoopback = loopbackForExternal(7448);
    const deps = fakeDeps(
      {
        isUnitActive: (unit) => unit !== deadUnit,
        isPortListening: (port) => port !== deadLoopback,
      },
      stopped,
    );
    const result = claimSlot({ branch: "t3code/reclaimer", worktreePath: "/tmp/wt" }, deps);
    assert.equal(result.reclaimedFrom, 7448);
    assert.equal(result.claim.externalPort, 7448);
    assert.include(stopped, deadUnit);
  });

  it("does NOT reclaim a still-starting slot inside its startup grace window", () => {
    const stopped: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      claimSlot({ branch: `t3code/b${i}`, worktreePath: "/tmp/wt" }, fakeDeps({}, stopped));
    }
    // Slot 7448's unit is dead and its port is free (it is mid build/start), but
    // its claim is FRESH. Reclaim must treat it as alive and refuse to evict it,
    // otherwise a second agent double-claims the port and tears out the deploy.
    const deadUnit = unitForExternal(7448);
    const deadLoopback = loopbackForExternal(7448);
    const deps = fakeDeps(
      {
        isUnitActive: (unit) => unit !== deadUnit,
        isPortListening: (port) => port !== deadLoopback,
      },
      stopped,
    );
    assert.throws(
      () => claimSlot({ branch: "t3code/racer", worktreePath: "/tmp/wt" }, deps),
      PoolExhaustedError,
    );
    assert.notInclude(stopped, deadUnit);
  });
});

describe("staleness", () => {
  it("alive when unit active", () => {
    const claim = buildClaim(7444, { branch: "t3code/a", worktreePath: "/tmp/wt" });
    assert.equal(computeSlotState(claim, aliveProbe), "alive");
  });

  it("stale only when unit inactive AND port empty (fake dead pid)", () => {
    const claim = buildClaim(7444, { branch: "t3code/a", worktreePath: "/tmp/wt" });
    // Evaluate past the startup grace window so a freshly-built claim can be stale.
    const later = Date.parse(claim.claimedAt) + STARTUP_GRACE_MS + 1000;
    const deadProbe: SlotProbe = { isUnitActive: () => false, isPortListening: () => false };
    assert.equal(computeSlotState(claim, deadProbe, later), "stale");
    // Port still held => not reclaimable.
    const portHeld: SlotProbe = { isUnitActive: () => false, isPortListening: () => true };
    assert.equal(computeSlotState(claim, portHeld, later), "alive");
  });

  it("keeps a freshly-claimed slot alive during the startup grace window", () => {
    const claim = buildClaim(7444, { branch: "t3code/a", worktreePath: "/tmp/wt" });
    const deadProbe: SlotProbe = { isUnitActive: () => false, isPortListening: () => false };
    // Unit dead + port free, but the claim was just written (mid build/start) =>
    // protected from reclaim/teardown by the startup grace window.
    assert.equal(computeSlotState(claim, deadProbe), "alive");
    // The same slot, aged past the window => genuinely stale.
    const later = Date.parse(claim.claimedAt) + STARTUP_GRACE_MS + 1;
    assert.equal(computeSlotState(claim, deadProbe, later), "stale");
  });

  it("gives no startup grace to a timestampless (corrupt-derived) claim", () => {
    const derived = derivedClaimForPort(7444);
    const deadProbe: SlotProbe = { isUnitActive: () => false, isPortListening: () => false };
    // derivedClaimForPort has claimedAt "" => Date.parse is NaN => no grace.
    assert.equal(computeSlotState(derived, deadProbe), "stale");
  });
});

describe("seedBaseDir", () => {
  function makeProdUserdata(): string {
    const prod = mkdtempSync(join(tmpdir(), "t3-prod-userdata-"));
    writeFileSync(join(prod, "settings.json"), '{"a":1}');
    writeFileSync(join(prod, "environment-id"), "prod-env-id");
    writeFileSync(join(prod, "state.sqlite"), "PRODDB");
    mkdirSync(join(prod, "secrets"));
    writeFileSync(join(prod, "secrets", "openai"), "sk-test");
    return prod;
  }

  it("minimal copies settings + secrets but not DB or environment-id", () => {
    const prod = makeProdUserdata();
    const result = seedBaseDir(7444, "minimal", prod);
    assert.equal(result, "seeded-minimal");
    const userdata = join(baseDirFor(7444), "userdata");
    assert.isTrue(existsSync(join(userdata, "settings.json")));
    assert.isTrue(existsSync(join(userdata, "secrets", "openai")));
    assert.isFalse(existsSync(join(userdata, "state.sqlite")));
    assert.isFalse(existsSync(join(userdata, "environment-id")));
    rmSync(prod, { recursive: true, force: true });
  });

  it("copy clones everything, empty copies nothing, and existing is kept", () => {
    const prod = makeProdUserdata();
    assert.equal(seedBaseDir(7445, "copy", prod), "seeded-copy");
    assert.isTrue(existsSync(join(baseDirFor(7445), "userdata", "state.sqlite")));

    assert.equal(seedBaseDir(7446, "empty", prod), "seeded-empty");
    assert.isFalse(existsSync(join(baseDirFor(7446), "userdata", "settings.json")));

    // Redeploy: second call keeps the existing base-dir untouched.
    writeFileSync(join(baseDirFor(7446), "userdata", "marker"), "x");
    assert.equal(seedBaseDir(7446, "minimal", prod), "kept-existing");
    assert.equal(readFileSync(join(baseDirFor(7446), "userdata", "marker"), "utf8"), "x");
    rmSync(prod, { recursive: true, force: true });
  });
});

describe("curated seed template (deploy side)", () => {
  function publishFakeTemplate(name = "2026-07-09T00-00-00Z"): string {
    ensureRegistry();
    const { seedVersions, seedTemplate } = registryPaths();
    const version = join(seedVersions, name);
    const userdata = join(version, "userdata");
    mkdirSync(userdata, { recursive: true });
    writeFileSync(join(userdata, "state.sqlite"), "TEMPLATEDB");
    writeFileSync(join(userdata, "settings.json"), "{}");
    writeFileSync(
      join(version, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        builtAt: "2026-07-09T00:00:00.000Z",
        dbSchemaVersion: 32,
        prodGitSha: "abc1234",
        keptThreadIds: ["thread-1"],
      }),
    );
    symlinkSync(join("seed-versions", name), seedTemplate);
    return userdata;
  }

  it("resolves a published template via the symlink + reads its manifest", () => {
    publishFakeTemplate();
    const template = resolveSeedTemplate();
    assert.isNotNull(template);
    assert.isTrue(existsSync(join(template!.userdata, "state.sqlite")));
    const manifest = readSeedManifest(template!.dir);
    assert.equal(manifest?.dbSchemaVersion, 32);
    assert.equal(manifest?.prodGitSha, "abc1234");
  });

  it("treats a missing or dangling symlink as no template", () => {
    ensureRegistry();
    assert.isNull(resolveSeedTemplate()); // no symlink at all
    const { seedTemplate } = registryPaths();
    symlinkSync(join("seed-versions", "does-not-exist"), seedTemplate); // dangling
    assert.isNull(resolveSeedTemplate());
  });

  it("seedBaseDir curated copies the template userdata into a fresh slot", () => {
    publishFakeTemplate();
    assert.equal(seedBaseDir(7444, "curated"), "seeded-curated");
    const slot = join(baseDirFor(7444), "userdata");
    assert.equal(readFileSync(join(slot, "state.sqlite"), "utf8"), "TEMPLATEDB");
    assert.isTrue(existsSync(join(slot, "settings.json")));
  });

  it("seedBaseDir curated throws when no template is present", () => {
    ensureRegistry();
    assert.throws(() => seedBaseDir(7445, "curated"), /no curated template/);
  });
});

describe("worktreeMigrationCount", () => {
  it("counts NNN_*.ts migration files, excluding *.test.ts and non-migrations", () => {
    const wt = mkdtempSync(join(tmpdir(), "t3-wt-"));
    const dir = join(wt, "apps", "server", "src", "persistence", "Migrations");
    mkdirSync(dir, { recursive: true });
    for (const name of ["001_A.ts", "002_B.ts", "002_B.test.ts", "readme.md", "helper.ts"]) {
      writeFileSync(join(dir, name), "");
    }
    assert.equal(worktreeMigrationCount(wt), 2);
    assert.equal(worktreeMigrationCount(join(tmpdir(), "does-not-exist-xyz")), 0);
    rmSync(wt, { recursive: true, force: true });
  });
});

describe("attachment segment helpers", () => {
  it("round-trips a thread id through segment + file-name parse (uuid + import)", () => {
    for (const threadId of [
      "1c9df8e0-1111-2222-3333-444455556666",
      "claude-import-1c9df8e0-1111-2222-3333-444455556666",
    ]) {
      const segment = toSafeThreadAttachmentSegment(threadId);
      assert.isNotNull(segment);
      const fileName = `${segment}-1c9df8e0-aaaa-bbbb-cccc-dddddddddddd.png`;
      assert.equal(attachmentFileThreadSegment(fileName), segment);
    }
  });

  it("rejects file names that are not attachment ids", () => {
    assert.isNull(attachmentFileThreadSegment("no-extension"));
    assert.isNull(attachmentFileThreadSegment("not-a-real-uuid.png"));
  });
});

describe("parsePairingUrl", () => {
  it("reads a url field", () => {
    assert.equal(
      parsePairingUrl(
        '{"url":"https://15.204.108.12:7444/pair#token=abc"}',
        "https://15.204.108.12:7444",
      ),
      "https://15.204.108.12:7444/pair#token=abc",
    );
  });
  it("builds from a bare token", () => {
    assert.equal(
      parsePairingUrl('{"token":"xyz"}', "http://127.0.0.1:8080"),
      "http://127.0.0.1:8080/pair#token=xyz",
    );
  });
  it("falls back to scanning plain text", () => {
    assert.equal(
      parsePairingUrl("Pair here: https://15.204.108.12:7445/pair#token=q1w2 (5m)", "https://x"),
      "https://15.204.108.12:7445/pair#token=q1w2",
    );
  });
  it("throws when no url is present", () => {
    assert.throws(() => parsePairingUrl("nothing useful", "https://x"));
  });
});

describe("PR comment (spec ADDENDUM)", () => {
  const paired = "https://15.204.108.12:7444/pair#token=abc";

  it("embeds the clickable link + re-mint command when external is live", () => {
    const body = buildPrCommentBody({ externalPort: 7444, loopbackPort: 3774, pairedUrl: paired });
    assert.include(body, "## Test deployment");
    assert.include(body, paired);
    assert.include(body, `(${paired})`); // markdown link target
    assert.include(body, "node scripts/test-status.ts --pair 7444");
  });

  it("falls back to SSH-tunnel instructions in degraded mode", () => {
    const body = buildPrCommentBody({ externalPort: 7444, loopbackPort: 3774, pairedUrl: null });
    assert.include(body, "ssh -L 8080:127.0.0.1:3774");
    assert.include(body, "--base-url http://127.0.0.1:8080");
    assert.notInclude(body, "token=abc");
  });

  it("builds gh argv and a shell-safe one-liner", () => {
    const body = buildPrCommentBody({ externalPort: 7444, loopbackPort: 3774, pairedUrl: paired });
    const args = ghCommentArgs("https://github.com/DanielGGordon/t3code/pull/9", body);
    assert.deepEqual(args.slice(0, 4), [
      "pr",
      "comment",
      "https://github.com/DanielGGordon/t3code/pull/9",
      "--body",
    ]);
    const line = ghCommentCommandLine(
      "https://github.com/DanielGGordon/t3code/pull/9",
      "it's a test",
    );
    // Single-quoted body with an escaped embedded apostrophe.
    assert.include(line, "gh pr comment https://github.com/DanielGGordon/t3code/pull/9 --body '");
    assert.include(line, "'\\''");
  });
});
