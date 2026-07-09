import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";

const script = join(import.meta.dirname, "test-deploy-caddy.ts");

it("prints 10 Caddy blocks for 7444..7453 and never a prod target", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  for (let port = 7444; port <= 7453; port += 1) {
    assert.include(out, `https://15.204.108.12:${port} {`);
    assert.include(out, `reverse_proxy 127.0.0.1:${port - 3670} {`);
  }
  // Exactly 10 reverse_proxy blocks.
  assert.lengthOf(out.match(/reverse_proxy/g) ?? [], 10);
  // Never leak prod.
  assert.notInclude(out, ":7443 {");
  assert.notInclude(out, "127.0.0.1:3773");
});
