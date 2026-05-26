import assert from "node:assert/strict";
import {
  isOfficialOutputTypeName,
  validateOfficialOutputMaterialMapping,
  validateOfficialOutputMaterialMappingOutputTypes,
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
    const outputs = declaredOutputs(descriptor.outputs, label);
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

      assert.deepEqual(
        validateOfficialOutputMaterialMappingOutputTypes(
          contract,
          publication.exampleMaterialMapping,
          outputs,
        ),
        [],
        `${label}.${name}: output markers must match declared output types`,
      );
    }
  }
});

function declaredOutputs(
  outputs: readonly unknown[] | undefined,
  label: string,
) {
  assert.ok(Array.isArray(outputs), `${label}: outputs must be an array`);
  const fields: {
    readonly name: string;
    readonly type: string;
    readonly required?: boolean;
  }[] = [];
  for (const [index, raw] of outputs.entries()) {
    assert.ok(
      raw && typeof raw === "object" && !Array.isArray(raw),
      `${label}.outputs[${index}] must be an object`,
    );
    const name = (raw as { readonly name?: unknown }).name;
    if (typeof name !== "string") {
      assert.fail(`${label}.outputs[${index}].name must be a string`);
    }
    const type = (raw as { readonly type?: unknown }).type;
    if (typeof type !== "string") {
      assert.fail(`${label}.outputs[${index}].type must be a string`);
    }
    const required = (raw as { readonly required?: unknown }).required;
    if (typeof required !== "boolean") {
      assert.fail(`${label}.outputs[${index}].required must be a boolean`);
    }
    fields.push({ name, type, required });
  }
  return fields;
}
