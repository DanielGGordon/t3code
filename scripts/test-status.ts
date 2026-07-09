// Inspect the test-deploy pool and re-mint pairing links.
//
//   node scripts/test-status.ts                       # table: alive/stale/free
//   node scripts/test-status.ts --json
//   node scripts/test-status.ts --pair <ext>          # fresh pairing link
//   node scripts/test-status.ts --pair <ext> --base-url http://127.0.0.1:8080
//   node scripts/test-status.ts --set-pr <url> --port <ext>
//
// Read-only except --pair (mints a token) and --set-pr (rewrites one claim).

import { parseArgs } from "node:util";

import {
  assertNotProd,
  claimPathFor,
  computeSlotState,
  derivedClaimForPort,
  ensureRegistry,
  externalPorts,
  isBootstrapped,
  loopbackForExternal,
  mintPairingLink,
  readClaim,
  realProbe,
  testUrlFor,
  unitForExternal,
  updateClaim,
  type Claim,
  type SlotState,
} from "./test-deploy-lib.ts";

interface SlotRow {
  slot: number;
  externalPort: number;
  loopbackPort: number;
  state: SlotState;
  branch: string;
  prUrl: string | null;
  claimedAt: string | null;
  pid: number | null;
  corrupt: boolean;
}

function collectRows(): SlotRow[] {
  const rows: SlotRow[] = [];
  let slot = 0;
  for (const externalPort of externalPorts()) {
    const loopbackPort = loopbackForExternal(externalPort);
    const unit = unitForExternal(externalPort);
    assertNotProd(externalPort, loopbackPort, unit);
    const read = readClaim(externalPort);
    if (read.status === "missing") {
      rows.push({
        slot,
        externalPort,
        loopbackPort,
        state: "free",
        branch: "-",
        prUrl: null,
        claimedAt: null,
        pid: null,
        corrupt: false,
      });
    } else if (read.status === "corrupt") {
      // A corrupt claim file is NOT automatically stale. Mirror
      // reclaimStaleSlot: probe the slot's derived unit/port and only report
      // "stale" when they are actually dead. Otherwise the slot is still serving
      // (just with an unreadable claim), so report "alive" — reporting it stale
      // would invite an agent to tear down a live deployment on a false positive.
      const state = computeSlotState(derivedClaimForPort(externalPort), realProbe);
      rows.push({
        slot,
        externalPort,
        loopbackPort,
        state,
        branch: "<corrupt>",
        prUrl: null,
        claimedAt: null,
        pid: null,
        corrupt: true,
      });
    } else {
      const claim = read.claim;
      rows.push({
        slot,
        externalPort,
        loopbackPort,
        state: computeSlotState(claim, realProbe),
        branch: claim.branch,
        prUrl: claim.prUrl,
        claimedAt: claim.claimedAt,
        pid: claim.pid,
        corrupt: false,
      });
    }
    slot += 1;
  }
  return rows;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printTable(rows: SlotRow[]): void {
  const header = [
    pad("SLOT", 5),
    pad("EXTERNAL", 9),
    pad("LOOPBACK", 9),
    pad("STATE", 6),
    pad("BRANCH", 34),
    pad("PR", 4),
    "CLAIMED",
  ].join(" ");
  process.stdout.write(`${header}\n`);
  for (const row of rows) {
    const line = [
      pad(String(row.slot), 5),
      pad(String(row.externalPort), 9),
      pad(String(row.loopbackPort), 9),
      pad(row.state, 6),
      pad(row.branch, 34),
      pad(row.prUrl ? "yes" : "-", 4),
      row.claimedAt ?? "-",
    ].join(" ");
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `\nCaddy bootstrap: ${isBootstrapped() ? "enabled (external URLs live)" : "NOT bootstrapped (degraded / tunnel mode)"}\n`,
  );
}

function requireLiveClaim(externalPort: number): Claim {
  const read = readClaim(externalPort);
  if (read.status !== "ok") {
    throw new Error(`Slot ${externalPort} is ${read.status === "missing" ? "free" : "corrupt"}; nothing to pair.`);
  }
  const state = computeSlotState(read.claim, realProbe);
  if (state !== "alive") {
    throw new Error(`Slot ${externalPort} is ${state}; deploy it before minting a pairing link.`);
  }
  return read.claim;
}

function doPair(externalPort: number, baseUrlArg: string | undefined): void {
  const claim = requireLiveClaim(externalPort);
  const baseUrl = baseUrlArg && baseUrlArg.length > 0 ? baseUrlArg : testUrlFor(externalPort);
  const url = mintPairingLink({
    worktreePath: claim.worktreePath,
    baseDir: claim.baseDir,
    baseUrl,
    ttl: "1h",
    label: `${claim.unit} ${claim.branch}`,
  });
  process.stdout.write(`${url}\n`);
}

function main(): void {
  ensureRegistry();
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      pair: { type: "string" },
      "base-url": { type: "string" },
      "set-pr": { type: "string" },
      port: { type: "string" },
    },
  });

  if (values["set-pr"] !== undefined) {
    if (values.port === undefined) {
      throw new Error("--set-pr requires --port <externalPort>.");
    }
    const externalPort = Number.parseInt(values.port, 10);
    assertNotProd(externalPort, loopbackForExternal(externalPort), unitForExternal(externalPort));
    if (readClaim(externalPort).status !== "ok") {
      throw new Error(`No live claim for port ${externalPort} (claim file at ${claimPathFor(externalPort)}).`);
    }
    updateClaim(externalPort, { prUrl: values["set-pr"] });
    process.stdout.write(`Set prUrl for slot ${externalPort}.\n`);
    return;
  }

  if (values.pair !== undefined) {
    const externalPort = Number.parseInt(values.pair, 10);
    assertNotProd(externalPort, loopbackForExternal(externalPort), unitForExternal(externalPort));
    doPair(externalPort, values["base-url"]);
    return;
  }

  const rows = collectRows();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  printTable(rows);
}

main();
