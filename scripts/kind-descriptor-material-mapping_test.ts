import assert from "node:assert/strict";
import {
  isOfficialOutputTypeName,
  validateOfficialOutputMaterialMapping,
} from "takosumi-contract/type-catalog";

const PORTABLE_KIND_PACKAGES = [
  "kind-worker",
  "kind-web-service",
  "kind-postgres",
  "kind-object-store",
  "kind-gateway",
] as const;

Deno.test("portable kind descriptors publish official material mappings", async () => {
  for (const pkg of PORTABLE_KIND_PACKAGES) {
    const path = new URL(
      `../packages/${pkg}/spec/kind.jsonld`,
      import.meta.url,
    );
    const descriptor = JSON.parse(await Deno.readTextFile(path)) as {
      readonly name?: string;
      readonly publications?: Record<string, unknown>;
      readonly outputs?: readonly unknown[];
    };
    const label = descriptor.name ?? pkg;
    const outputNames = declaredOutputNames(descriptor.outputs, label);
    const publications = descriptor.publications;

    assert.ok(
      publications && typeof publications === "object" &&
        !Array.isArray(publications),
      `${label}: publications must be an object`,
    );

    for (const [name, raw] of Object.entries(publications)) {
      assert.ok(
        raw && typeof raw === "object" && !Array.isArray(raw),
        `${label}.${name}: publication must be an object`,
      );
      const publication = raw as {
        readonly contract?: unknown;
        readonly exampleMaterialMapping?: unknown;
      };
      const contract = publication.contract;
      if (typeof contract !== "string") {
        assert.fail(`${label}.${name}: contract must be a string`);
      }
      assert.ok(
        isOfficialOutputTypeName(contract),
        `${label}.${name}: contract must be an official output type`,
      );
      assert.ok(
        publication.exampleMaterialMapping &&
          typeof publication.exampleMaterialMapping === "object" &&
          !Array.isArray(publication.exampleMaterialMapping),
        `${label}.${name}: exampleMaterialMapping must be an object`,
      );

      assert.deepEqual(
        validateOfficialOutputMaterialMapping(
          contract,
          publication.exampleMaterialMapping,
        ),
        [],
        `${label}.${name}: exampleMaterialMapping must match official material shape`,
      );

      for (
        const marker of collectOutputMarkers(publication.exampleMaterialMapping)
      ) {
        assert.ok(
          outputNames.has(marker),
          `${label}.${name}: ${marker} is not declared in outputs[]`,
        );
      }
    }
  }
});

function declaredOutputNames(
  outputs: readonly unknown[] | undefined,
  label: string,
) {
  assert.ok(Array.isArray(outputs), `${label}: outputs must be an array`);
  const names = new Set<string>();
  for (const [index, raw] of outputs.entries()) {
    assert.ok(
      raw && typeof raw === "object" && !Array.isArray(raw),
      `${label}.outputs[${index}] must be an object`,
    );
    const name = (raw as { readonly name?: unknown }).name;
    if (typeof name !== "string") {
      assert.fail(`${label}.outputs[${index}].name must be a string`);
    }
    names.add(name);
  }
  return names;
}

function collectOutputMarkers(value: unknown): readonly string[] {
  const markers: string[] = [];
  collect(value);
  return markers;

  function collect(entry: unknown): void {
    if (typeof entry === "string" && entry.startsWith("$outputs.")) {
      markers.push(entry.slice("$outputs.".length));
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) collect(item);
      return;
    }
    if (entry && typeof entry === "object") {
      for (const item of Object.values(entry)) collect(item);
    }
  }
}
