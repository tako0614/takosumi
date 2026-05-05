import assert from "node:assert/strict";
import { versionCommand } from "../src/commands/version.ts";
import { TAKOSUMI_CLI_VERSION } from "../src/version.ts";

Deno.test("version command prints the package CLI version", async () => {
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...parts: unknown[]) => {
    output.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    await versionCommand.parse([]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output, [`takosumi ${TAKOSUMI_CLI_VERSION}`]);
});
