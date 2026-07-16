#!/usr/bin/env bun

import {
  requireProviderCompatibilityReleaseReady,
  verifyProviderCompatibility,
} from "./lib/provider-release-compatibility.mjs";

const command = process.argv[2];
if (process.argv.length !== 3) throw new Error("expected exactly one compatibility command");

if (command === "check") {
  process.stdout.write(`${JSON.stringify(await verifyProviderCompatibility(), null, 2)}\n`);
} else if (command === "release-check") {
  await requireProviderCompatibilityReleaseReady();
} else if (command === "state-proof") {
  await import("../tests/proofs/provider-state-compatibility.ts");
} else {
  throw new Error(`unknown provider compatibility command ${String(command)}`);
}
