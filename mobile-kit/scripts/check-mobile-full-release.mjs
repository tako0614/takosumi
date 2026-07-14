#!/usr/bin/env bun
import { spawn } from "node:child_process";

const checks = [
  {
    label: "native release readiness",
    args: ["run", "release:native-check"],
  },
  {
    label: "store/signing/device release evidence",
    args: ["run", "release:evidence-check"],
  },
  {
    label: "release status parity",
    args: ["run", "release:status", "--", "--fail-on-blockers"],
  },
];

const failures = [];

for (const check of checks) {
  console.log(`\n==> ${check.label}`);
  const code = await run("bun", check.args);
  if (code !== 0) failures.push({ label: check.label, code });
}

if (failures.length > 0) {
  console.error("\nMobile product release check failed:");
  for (const failure of failures) {
    console.error(`- ${failure.label} exited with ${failure.code}`);
  }
  process.exit(1);
}

console.log("\nMobile product release check passed.");

function run(command, args) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolveExit(code ?? 1));
    child.on("error", (error) => {
      console.error(error);
      resolveExit(1);
    });
  });
}
