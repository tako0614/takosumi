import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../commands/init.ts";

test("init command prints generic repository metadata by default", async () => {
  const output = await captureStdout(() => initCommand.parseAsync([]));

  assert.match(output, /"name": "my-app"/);
  assert.equal(output.includes("apiVersion"), false);
  assert.equal(output.includes("components"), false);
});

test("init command writes the package template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-init-"));
  const tmp = join(dir, "package.json");
  try {
    await captureStdout(() =>
      initCommand.parseAsync(["--template", "package", tmp])
    );

    const text = await readFile(tmp, "utf8");
    assert.match(text, /"description": "OpenTofu-native Takosumi source"/);
    assert.equal(text.includes("apiVersion"), false);
    assert.equal(text.includes("components"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}
