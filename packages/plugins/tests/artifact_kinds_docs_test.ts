import assert from "node:assert/strict";
import { TAKOSUMI_BUNDLED_ARTIFACT_KINDS } from "../src/shape-providers/mod.ts";

Deno.test("artifact kinds reference documents the bundled registry", async () => {
  // Phase M Wave 3 Group A: docs/reference/artifact-kinds.md was merged into
  // docs/reference/kind-catalog.md (Artifact Kinds section, anchor
  // `#artifact-kinds`). This test reads the consolidated doc.
  const source = await Deno.readTextFile(
    new URL("../../../docs/reference/kind-catalog.md", import.meta.url),
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
