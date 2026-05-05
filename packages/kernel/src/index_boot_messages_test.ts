import assert from "node:assert/strict";

Deno.test("kernel startup diagnostics reference current docs", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );

  assert.equal(source.includes("docs/hosting/"), false);

  for (
    const docPath of [
      "docs/operator/self-host.md",
      "docs/reference/secret-partitions.md",
      "docs/reference/env-vars.md",
      "docs/reference/audit-events.md",
    ]
  ) {
    assert.ok(
      source.includes(docPath),
      `expected index.ts to mention ${docPath}`,
    );
  }
});
