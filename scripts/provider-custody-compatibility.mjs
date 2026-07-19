#!/usr/bin/env bun

import { verifyProviderCompatibility } from "./lib/provider-custody-compatibility.mjs";

const [command, ...args] = process.argv.slice(2);
let proofPath;
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--evidence") {
    throw new Error("expected --evidence <provider-compatibility-proof.json>");
  }
  proofPath = args[1];
}

if (command === "check") {
  process.stdout.write(
    `${JSON.stringify(await verifyProviderCompatibility({ proofPath }), null, 2)}\n`,
  );
} else if (command === "state-proof") {
  if (proofPath) {
    process.env.TAKOSUMI_PROVIDER_COMPATIBILITY_PROOF_PATH = proofPath;
  }
  await import("../tests/proofs/provider-state-compatibility.ts");
} else {
  throw new Error(`unknown provider compatibility command ${String(command)}`);
}
