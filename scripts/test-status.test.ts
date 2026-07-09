import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, assert, beforeEach, it } from "@effect/vitest";

const script = join(import.meta.dirname, "test-status.ts");

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3-status-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, T3_TEST_DEPLOY_HOME: home },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

it("bootstraps an empty registry and reports 10 free slots", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.include(result.stdout, "SLOT");
  assert.lengthOf(result.stdout.match(/free/g) ?? [], 10);
  assert.include(result.stdout, "NOT bootstrapped");
});

it("emits JSON for all 10 slots", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout) as Array<{ externalPort: number; state: string }>;
  assert.lengthOf(rows, 10);
  assert.equal(rows[0]?.externalPort, 7444);
  assert.equal(rows[9]?.externalPort, 7453);
  assert.isTrue(rows.every((r) => r.state === "free"));
});

it("refuses to pair a free/stale slot", () => {
  const result = run(["--pair", "7444"]);
  assert.notEqual(result.status, 0);
  assert.include(result.stderr, "free");
});
