import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, assert, beforeEach, it } from "@effect/vitest";

const script = join(import.meta.dirname, "test-deploy.ts");

let home = "";
let cwd = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3-deploy-home-"));
  cwd = mkdtempSync(join(tmpdir(), "t3-deploy-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, T3_TEST_DEPLOY_HOME: home },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

it("rejects an invalid --seed before any deployment side effect", () => {
  const result = run(["--seed", "bogus", "--note", "x"]);
  assert.notEqual(result.status, 0);
  assert.include(result.stderr, "Invalid --seed");
});

it("refuses a non-t3code branch (guarding prod-shaped deploys)", () => {
  // A fresh temp dir is not a git repo, so git rev-parse fails; either way the
  // script must exit non-zero without claiming a slot / touching prod.
  const result = run(["--note", "x"]);
  assert.notEqual(result.status, 0);
});
