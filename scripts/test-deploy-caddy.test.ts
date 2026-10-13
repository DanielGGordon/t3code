import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";

const script = join(import.meta.dirname, "test-deploy-caddy.ts");

function run(args: string[], env: Record<string, string> = {}): string {
  const clean = { ...process.env };
  delete clean.T3_TEST_DEPLOY_URL_TEMPLATE;
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function assertNoProd(out: string): void {
  assert.notInclude(out, ":7443 {");
  assert.notInclude(out, "127.0.0.1:3773");
}

it("prints 10 marked hostname sites t3-test-7444..7453.gordonlabs.dev by default", () => {
  const out = run([]);
  assert.match(out, /^# --- BEGIN t3-test-pool-hosts /);
  assert.match(out, /# --- END t3-test-pool-hosts ---\n$/);
  for (let port = 7444; port <= 7453; port += 1) {
    assert.include(
      out,
      `t3-test-${port}.gordonlabs.dev {\n    encode gzip\n    reverse_proxy 127.0.0.1:${port - 3670} {`,
    );
  }
  assert.lengthOf(out.match(/reverse_proxy/g) ?? [], 10);
  assert.include(out, "header_up X-Forwarded-Proto {scheme}");
  // Hostname sites get Caddy's managed certs: no tls line, no bare IP.
  assert.notInclude(out, "tls ");
  assert.notInclude(out, "https://");
  assertNoProd(out);
});

it("follows T3_TEST_DEPLOY_URL_TEMPLATE", () => {
  const out = run([], { T3_TEST_DEPLOY_URL_TEMPLATE: "https://pool-{port}.example.test" });
  assert.include(out, "pool-7444.example.test {");
  assert.include(out, "pool-7453.example.test {");
  assert.notInclude(out, "gordonlabs.dev {");
});

it("--legacy-ip prints the bare-IP sites on the pinned cert", () => {
  const out = run(["--legacy-ip"], { T3_TEST_DEPLOY_HOST: "203.0.113.7" });
  for (let port = 7444; port <= 7453; port += 1) {
    assert.include(out, `https://203.0.113.7:${port} {`);
    assert.include(out, `reverse_proxy 127.0.0.1:${port - 3670} {`);
  }
  assert.lengthOf(out.match(/reverse_proxy/g) ?? [], 10);
  assert.include(out, "tls /etc/caddy/dancode-server.crt /etc/caddy/dancode-server.key");
  assertNoProd(out);
});
