import assert from "node:assert/strict";
import { TAKOSUMI_BUNDLED_ARTIFACT_KINDS } from "../src/shape-providers/mod.ts";

Deno.test("DataAsset metadata reference documents reference examples", async () => {
  // DataAsset metadata lives in the optional operator extension docs, separate
  // from AppSpec component kind descriptors.
  const source = await Deno.readTextFile(
    new URL("../../../docs/reference/data-asset-policy.md", import.meta.url),
  );
  for (const kind of TAKOSUMI_BUNDLED_ARTIFACT_KINDS) {
    assert.ok(source.includes(`\`${kind.kind}\``), `missing ${kind.kind}`);
  }

  for (
    const staleKind of [
      "js-module",
      "wasm-module",
      "static-archive",
      "source-archive",
    ]
  ) {
    assert.equal(source.includes(staleKind), false);
  }
});
