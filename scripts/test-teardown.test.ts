import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, assert, beforeEach, it } from "@effect/vitest";

const script = join(import.meta.dirname, "test-teardown.ts");

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3-teardown-"));
  mkdirSync(join(home, "claims"), { recursive: true });
  mkdirSync(join(home, "base-dirs"), { recursive: true });
  mkdirSync(join(home, "logs"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedClaim(externalPort: number, branch: string, worktreePath = "/tmp/does-not-exist"): void {
  const claim = {
    schemaVersion: 1,
    externalPort,
    loopbackPort: externalPort - 3670,
    testUrl: `https://15.204.108.12:${externalPort}`,
    branch,
    worktreePath,
    baseDir: join(home, "base-dirs", String(externalPort)),
    prUrl: null,
    unit: `t3-test-${externalPort}.service`,
    pid: null,
    claimedAt: new Date().toISOString(),
    agentNote: null,
  };
  writeFileSync(join(home, "claims", `${externalPort}.json`), JSON.stringify(claim));
  const userdata = join(home, "base-dirs", String(externalPort), "userdata");
  mkdirSync(userdata, { recursive: true });
  writeFileSync(join(userdata, "marker"), "x");
}

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, T3_TEST_DEPLOY_HOME: home },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

it("releases the claim but KEEPS the base-dir by default", () => {
  seedClaim(7444, "t3code/keepme");
  const result = run(["--port", "7444"]);
  assert.equal(result.status, 0, result.stderr);
  assert.isFalse(existsSync(join(home, "claims", "7444.json")));
  assert.isTrue(existsSync(join(home, "base-dirs", "7444", "userdata", "marker")));
});

it("--purge also drops the base-dir", () => {
  seedClaim(7445, "t3code/dropme");
  const result = run(["--port", "7445", "--purge"]);
  assert.equal(result.status, 0, result.stderr);
  assert.isFalse(existsSync(join(home, "claims", "7445.json")));
  assert.isFalse(existsSync(join(home, "base-dirs", "7445")));
});

it("resolves the port from --branch", () => {
  seedClaim(7446, "t3code/by-branch");
  const result = run(["--branch", "t3code/by-branch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.isFalse(existsSync(join(home, "claims", "7446.json")));
});

it("refuses --port 7443 (prod)", () => {
  const result = run(["--port", "7443"]);
  assert.notEqual(result.status, 0);
  assert.include(result.stderr, "prod");
});

it("--remove-worktree refuses to remove the prod checkout", () => {
  // A claim whose worktreePath is the prod checkout (via manual registry repair,
  // an older buggy deploy, or a path bypass) must never be git-worktree-removed.
  seedClaim(7447, "t3code/prodish", "/home/dgordon/projects/meta/t3code-v2");
  const result = run(["--port", "7447", "--remove-worktree"]);
  // Teardown still stops + releases, but the worktree removal is hard-refused.
  assert.equal(result.status, 0, result.stderr);
  assert.include(result.stderr, "refusing to remove the prod checkout");
  assert.isFalse(existsSync(join(home, "claims", "7447.json")));
});
