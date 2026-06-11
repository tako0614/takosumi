import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

test("service startup diagnostics reference current docs", async () => {
  const source = await readText(
    new URL("./index.ts", import.meta.url),
  );

  assert.equal(source.includes("docs/hosting/"), false);

  for (const docPath of [
    "docs/reference/operator.md",
    "docs/reference/internal-execution-profiles.md",
  ]) {
    assert.ok(
      source.includes(docPath),
      `expected index.ts to mention ${docPath}`,
    );
  }
});

async function readText(path: URL | string): Promise<string> {
  return readFile(path, "utf8");
}
