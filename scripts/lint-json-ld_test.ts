import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const ROOT = new URL("../", import.meta.url);

test("JSON-LD linter is scoped to public contexts", async () => {
  const source = await readText(new URL("scripts/lint-json-ld.ts", ROOT));

  assert.match(source, /spec\/contexts/);
  assert.equal(source.includes("docs/ki" + "nds"), false);
  assert.equal(source.includes("/ki" + "nds/v1"), false);
});

test("v1 context exposes takosumi.com vocabulary", async () => {
  const source = await readText(new URL("spec/contexts/v1.jsonld", ROOT));
  const parsed = JSON.parse(source) as {
    readonly "@context"?: { readonly "@vocab"?: unknown };
  };

  assert.equal(parsed["@context"]?.["@vocab"], "https://takosumi.com/vocab/v1#");
});

async function readText(path: URL): Promise<string> {
  return await readFile(path, "utf8");
}
