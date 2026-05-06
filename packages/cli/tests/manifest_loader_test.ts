import assert from "node:assert/strict";
import {
  loadManifest,
  resolveManifestPath,
  selectManifestPath,
} from "../src/manifest_loader.ts";

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

Deno.test("resolveManifestPath rejects when no path is supplied", async () => {
  await assert.rejects(
    () => resolveManifestPath(undefined),
    /manifest path is required/,
  );
});

Deno.test("resolveManifestPath error mentions takosumi-git for project layout", async () => {
  await assert.rejects(
    () => resolveManifestPath(undefined),
    /takosumi-git/,
  );
});

Deno.test("loadManifest rejects when no path is supplied", async () => {
  await assert.rejects(
    () => loadManifest(undefined),
    /manifest path is required/,
  );
});

Deno.test("resolveManifestPath returns the supplied path verbatim", async () => {
  const resolved = await resolveManifestPath("./some/manifest.yml");
  assert.equal(resolved, "./some/manifest.yml");
});

Deno.test("selectManifestPath rejects conflicting argument and flag", () => {
  assert.throws(
    () => selectManifestPath({ argument: "a.yml", flag: "b.yml" }),
    /either as an argument or with --manifest/,
  );
});

Deno.test("selectManifestPath returns undefined when neither is set", () => {
  assert.equal(selectManifestPath({}), undefined);
});

Deno.test("selectManifestPath prefers the flag over the argument when equal", () => {
  assert.equal(
    selectManifestPath({ argument: "a.yml", flag: "a.yml" }),
    "a.yml",
  );
});
