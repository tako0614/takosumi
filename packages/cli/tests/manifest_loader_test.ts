import assert from "node:assert/strict";
import { loadManifest } from "../src/manifest_loader.ts";

Deno.test("loadManifest parses YAML by extension", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".yml" });
  try {
    await Deno.writeTextFile(tmp, "name: hello\nport: 8080\n");
    const result = await loadManifest(tmp);
    assert.equal(result.format, "yaml");
    assert.deepEqual(result.value, { name: "hello", port: 8080 });
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("loadManifest parses JSON by extension", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmp, '{"name":"hello","port":8080}');
    const result = await loadManifest(tmp);
    assert.equal(result.format, "json");
    assert.deepEqual(result.value, { name: "hello", port: 8080 });
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("loadManifest falls back to YAML when extension is unknown", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".txt" });
  try {
    await Deno.writeTextFile(tmp, "name: hello\n");
    const result = await loadManifest(tmp);
    assert.deepEqual(result.value, { name: "hello" });
  } finally {
    await Deno.remove(tmp);
  }
});
