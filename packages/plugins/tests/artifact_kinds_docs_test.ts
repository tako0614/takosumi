import assert from "node:assert/strict";
import { TAKOSUMI_BUNDLED_ARTIFACT_KINDS } from "../src/shape-providers/mod.ts";

Deno.test("artifact kinds reference documents the bundled registry", async () => {
  const source = await Deno.readTextFile(
    new URL("../../../docs/reference/artifact-kinds.md", import.meta.url),
  );
  const kindLine = TAKOSUMI_BUNDLED_ARTIFACT_KINDS.map((kind) => kind.kind)
    .join(" | ");

  assert.ok(source.includes(kindLine));
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
