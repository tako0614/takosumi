import assert from "node:assert/strict";
import { initCommand } from "../commands/init.ts";

Deno.test("init command prints an AppSpec scaffold by default", async () => {
  const output = await captureStdout(() => initCommand.parse([]));

  assert.match(output, /apiVersion: v1/);
  assert.match(output, /components:/);
  // Wave K: AppSpec root no longer carries `kind: App` — the scaffold
  // must not regress and re-introduce it.
  assert.equal(/^kind: App$/m.test(output), false);
  assert.equal(output.includes("kind: Manifest"), false);
  assert.equal(output.includes("${ref:"), false);
});

Deno.test("init command writes the empty AppSpec template", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".takosumi.yml" });
  try {
    await captureStdout(() => initCommand.parse(["--template", "empty", tmp]));

    const text = await Deno.readTextFile(tmp);
    assert.match(text, /apiVersion: v1/);
    assert.match(text, /components:/);
    assert.match(text, /kind: worker/);
    // Wave K: AppSpec root no longer carries `kind: App`.
    assert.equal(/^kind: App$/m.test(text), false);
    assert.equal(text.includes("kind: Manifest"), false);
  } finally {
    await Deno.remove(tmp);
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
