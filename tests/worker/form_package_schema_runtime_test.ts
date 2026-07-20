import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

test("fixed and dynamic Form Package schemas execute without runtime code generation in workerd", async () => {
  const build = await Bun.build({
    entrypoints: [
      resolve(
        import.meta.dir,
        "../fixtures/workers/form-package-schema-runtime.ts",
      ),
    ],
    target: "browser",
    format: "esm",
    minify: true,
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Worker runtime regression bundle is missing");
  const bundle = await output.text();
  expect(bundle).not.toMatch(/\b(?:eval|Function)\s*\(/u);
  expect(bundle).not.toContain("ajv/dist/");
  expect(bundle).not.toContain("CodeGen");

  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [
      {
        type: "ESModule",
        path: "form-package-schema-runtime.mjs",
        contents: bundle,
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch("https://worker.test/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      fixedSchemaRejectedInvalidDefinition: true,
      interpretedSchemaAcceptedValidInstance: true,
      interpretedSchemaRejectedInvalidInstance: true,
    });
  } finally {
    await runtime.dispose();
  }
});
