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

Deno.test("resolveManifestPath discovers .takosumi manifest first", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.takosumi`);
    await Deno.writeTextFile(`${dir}/manifest.yml`, "name: root\n");
    await Deno.writeTextFile(
      `${dir}/.takosumi/manifest.yml`,
      "name: project\n",
    );

    const resolved = await resolveManifestPath(undefined, { cwd: dir });
    assert.equal(resolved, `${dir}/.takosumi/manifest.yml`);
    const loaded = await loadManifest(undefined, { cwd: dir });
    assert.deepEqual(loaded.value, { name: "project" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("selectManifestPath rejects conflicting argument and flag", () => {
  assert.throws(
    () => selectManifestPath({ argument: "a.yml", flag: "b.yml" }),
    /either as an argument or with --manifest/,
  );
});
