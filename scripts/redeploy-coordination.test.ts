// Concurrent /redeploy calls must collapse into one deploy. Runs the real redeploy.sh against
// a throwaway origin + deploy checkout, with fake systemctl/systemd-run/pnpm/curl/mise on PATH
// so nothing here can touch the real service. See .agents/skills/redeploy/redeploy.sh.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../.agents/skills/redeploy/redeploy.sh");

const FAKES: Record<string, string> = {
  // Pretend to be systemd: only the "service" and nothing else exists / is active.
  systemctl: `#!/usr/bin/env bash
echo "systemctl $*" >>"$ROOT/systemctl.log"
args=("$@"); [ "\${args[0]}" = --user ] && args=("\${args[@]:1}")
case "\${args[0]}" in
  cat) [ "\${args[1]}" = t3code.service ] ;;
  is-active) unit="\${args[\${#args[@]}-1]}"
    [ "$unit" = t3code.service ] && { [[ " \${args[*]} " == *" --quiet "* ]] || echo active; exit 0; }
    [[ " \${args[*]} " == *" --quiet "* ]] || echo inactive; exit 3 ;;
  *) exit 0 ;;
esac
`,
  // Runs the transient unit's command inline, so its side effects are done when redeploy.sh exits.
  "systemd-run": `#!/usr/bin/env bash
echo "systemd-run $*" >>"$ROOT/systemctl.log"
while [ "$1" != bash ]; do shift; done
exec "$@"
`,
  // A build can ask for origin/main to move underneath it: write a file named push-on-build.
  pnpm: `#!/usr/bin/env bash
case "$*" in
  *build*)
    echo build >>"$ROOT/builds.log"
    if [ -e "$ROOT/push-on-build" ]; then
      rm "$ROOT/push-on-build"
      git -C "$ROOT/author" commit -q --allow-empty -m "merged mid-build"
      git -C "$ROOT/author" push -q origin HEAD:main
    fi ;;
esac
`,
  curl: `#!/usr/bin/env bash
echo 200
`,
  sleep: `#!/usr/bin/env bash
exec /bin/sleep 0.05
`,
  // The idle gate: busy while a file named "busy" exists, idle otherwise.
  mise: `#!/usr/bin/env bash
case "$*" in
  *deploy-idle-check.ts*) [ -e "$ROOT/busy" ] && { echo "busy some-thread"; exit 1; }; exit 0 ;;
esac
exit 0
`,
};

let root: string;
let deployDir: string;
let stateDir: string;

function git(cwd: string, ...args: string[]) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "redeploy-test-"));
  const origin = NodePath.join(root, "origin.git");
  const author = NodePath.join(root, "author");
  deployDir = NodePath.join(root, "deploy");
  stateDir = NodePath.join(root, "state");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, author);
  git(
    author,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "c1",
  );
  git(author, "config", "user.name", "t");
  git(author, "config", "user.email", "t@t");
  git(author, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", origin, deployDir);
  const bin = NodePath.join(deployDir, "node_modules/.bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
    NodeFS.writeFileSync(NodePath.join(bin, name), body, { mode: 0o755 });
  }
  NodeFS.mkdirSync(NodePath.join(root, "caller-a"));
  NodeFS.mkdirSync(NodePath.join(root, "caller-b"));
  for (const caller of ["caller-a", "caller-b"]) git(NodePath.join(root, caller), "init", "-q");
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function redeploy(caller: string, ...args: string[]) {
  const child = NodeChildProcess.spawn("bash", [SCRIPT, ...args], {
    cwd: NodePath.join(root, caller),
    env: {
      ...process.env,
      ROOT: root,
      // The script puts $HOME/.local/share/mise/shims ahead of PATH; keep the real pnpm out.
      HOME: root,
      T3_DEPLOY_DIR: deployDir,
      T3_SERVICE: "t3code.service",
      T3_IMPORT_TIMER: "t3-import-fake.timer",
      T3_REDEPLOY_STATE_DIR: stateDir,
      T3_REDEPLOY_LOG: NodePath.join(root, "status.log"),
      T3_MISE_BIN: NodePath.join(deployDir, "node_modules/.bin/mise"),
      T3_BASE_DIR: root,
      T3_IDLE_SECS: "0",
      T3_IDLE_POLL_SECS: "0.05",
    },
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const done = new Promise<{ code: number | null; out: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, out })),
  );
  return { done, output: () => out };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const builds = () =>
  NodeFS.existsSync(NodePath.join(root, "builds.log"))
    ? NodeFS.readFileSync(NodePath.join(root, "builds.log"), "utf8").trim().split("\n").length
    : 0;
const deployed = () => NodeFS.readFileSync(NodePath.join(stateDir, "deployed"), "utf8").trim();
const originMain = () => git(deployDir, "ls-remote", "origin", "refs/heads/main").split("\t")[0];

it("a second call while one deploy is pending joins it instead of deploying again", async () => {
  NodeFS.writeFileSync(NodePath.join(root, "busy"), "");
  const first = redeploy("caller-a");
  await until(() => first.output().includes("busy:"));

  const second = await redeploy("caller-b").done;
  expect(second.code).toBe(0);
  expect(second.out).toContain("already pending");

  NodeFS.rmSync(NodePath.join(root, "busy"));
  const firstResult = await first.done;
  expect(firstResult.code).toBe(0);
  expect(firstResult.out).toContain("Also requested while this deploy was pending");
  expect(firstResult.out).toContain("caller-b");
  expect(builds()).toBe(1);
  expect(deployed()).toBe(originMain());
});

it("rebuilds before restarting when origin/main moves mid-build, so joiners are covered", async () => {
  NodeFS.writeFileSync(NodePath.join(root, "push-on-build"), "");
  const result = await redeploy("caller-a").done;
  expect(result.code).toBe(0);
  expect(result.out).toContain("syncing again");
  expect(builds()).toBe(2);
  expect(deployed()).toBe(originMain());
  expect(
    NodeFS.readFileSync(NodePath.join(root, "systemctl.log"), "utf8").match(/systemd-run/g),
  ).toHaveLength(1);
});

it("does nothing when origin/main is already deployed, unless forced", async () => {
  expect((await redeploy("caller-a").done).code).toBe(0);
  expect(builds()).toBe(1);

  const again = await redeploy("caller-b").done;
  expect(again.code).toBe(0);
  expect(again.out).toContain("already deployed and serving");
  expect(builds()).toBe(1);

  expect((await redeploy("caller-b", "--force").done).code).toBe(0);
  expect(builds()).toBe(2);
});

it("a stopped deploy frees the lock and reports itself ended, not in progress", async () => {
  NodeFS.writeFileSync(NodePath.join(root, "busy"), "");
  const first = redeploy("caller-a");
  await until(() => first.output().includes("busy:"));
  const status = await redeploy("caller-b", "--status").done;
  expect(status.out).toContain("IN PROGRESS");

  const pid = Number(
    NodeFS.readFileSync(NodePath.join(stateDir, "state"), "utf8").match(/^pid=(\d+)/m)?.[1],
  );
  process.kill(pid, "SIGTERM");
  await first.done;
  const after = await redeploy("caller-b", "--status").done;
  expect(after.out).toContain("none in progress");
  expect(after.out).toContain("ended");
});
