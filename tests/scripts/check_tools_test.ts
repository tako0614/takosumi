import { expect, test } from "bun:test";

import {
  REQUIRED_TOOLS,
  missingTools,
} from "../../scripts/check-tools.ts";

test("every required tool says why the gate needs it", () => {
  expect(REQUIRED_TOOLS.length).toBeGreaterThan(0);
  for (const tool of REQUIRED_TOOLS) {
    expect(tool.command).toMatch(/^[a-z][a-z0-9-]*$/u);
    expect(tool.why.length).toBeGreaterThan(20);
  }
});

test("an absent tool is reported, not skipped", async () => {
  const absent = await missingTools(REQUIRED_TOOLS, async () => false);
  expect(absent.map((tool) => tool.command)).toEqual(
    REQUIRED_TOOLS.map((tool) => tool.command),
  );
  expect(await missingTools(REQUIRED_TOOLS, async () => true)).toEqual([]);
});

test("the preflight resolves this machine's tools and refuses with 127", async () => {
  expect(await missingTools()).toEqual([]);

  const refusal = Bun.spawn(
    [process.execPath, "scripts/check-tools.ts"],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      // A PATH with nothing on it is the honest simulation of "the tools are
      // not here"; the interpreter is addressed absolutely so the probe, not
      // the spawn, is what fails.
      env: { PATH: "/nonexistent", HOME: process.env.HOME ?? "" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  // 127 is the shell's own "command not found", which is what this is.
  expect(await refusal.exited).toBe(127);
});
