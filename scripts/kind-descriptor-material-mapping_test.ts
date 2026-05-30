import assert from "node:assert/strict";
import {
  isOfficialMaterialKindName,
  isOutputFieldTypeName,
  OUTPUT_FIELD_TYPE_NAMES,
  type OutputFieldTypeDefinition,
  validateOfficialMaterialMapping,
  validateOfficialMaterialMappingOutputFields,
} from "takosumi-contract/catalog";

const PORTABLE_KIND_PACKAGES = [
  "worker",
  "web-service",
  "postgres",
  "object-store",
  "gateway",
  "sqlite",
  "kv-store",
  "message-queue",
  "vector-store",
] as const;

Deno.test("portable kind descriptors publish official material mappings", async () => {
  for (const pkg of PORTABLE_KIND_PACKAGES) {
    const path = new URL(
      `../src/kinds/${pkg}/spec/kind.jsonld`,
      import.meta.url,
    );
    const descriptor = JSON.parse(await Deno.readTextFile(path)) as {
      readonly name?: string;
      readonly outputSlots?: Record<string, unknown>;
      readonly outputs?: readonly unknown[];
    };
    const label = descriptor.name ?? pkg;
    const outputs = declaredOutputs(descriptor.outputs, label);
    assertDescriptorOutputs(outputs, label);
    const outputSlots = descriptor.outputSlots;

    assert.ok(
      outputSlots && typeof outputSlots === "object" &&
        !Array.isArray(outputSlots),
      `${label}: outputSlots must be an object`,
    );

    for (const [name, raw] of Object.entries(outputSlots)) {
      assert.ok(
        raw && typeof raw === "object" && !Array.isArray(raw),
        `${label}.${name}: output slot must be an object`,
      );
      const outputSlot = raw as {
        readonly contract?: unknown;
        readonly exampleMaterialMapping?: unknown;
      };
      const contract = outputSlot.contract;
      if (typeof contract !== "string") {
        assert.fail(`${label}.${name}: contract must be a string`);
      }
      assert.ok(
        isOfficialMaterialKindName(contract),
        `${label}.${name}: contract must be an official material kind`,
      );
      assert.ok(
        outputSlot.exampleMaterialMapping &&
          typeof outputSlot.exampleMaterialMapping === "object" &&
          !Array.isArray(outputSlot.exampleMaterialMapping),
        `${label}.${name}: exampleMaterialMapping must be an object`,
      );

      assert.deepEqual(
        validateOfficialMaterialMapping(
          contract,
          outputSlot.exampleMaterialMapping,
        ),
        [],
        `${label}.${name}: exampleMaterialMapping must match official material shape`,
      );

      assert.deepEqual(
        validateOfficialMaterialMappingOutputFields(
          contract,
          outputSlot.exampleMaterialMapping,
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
  const fields: OutputFieldTypeDefinition[] = [];
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
    if (!isOutputFieldTypeName(type)) {
      assert.fail(`${label}.outputs[${index}].type is unsupported: ${type}`);
    }
    const required = (raw as { readonly required?: unknown }).required;
    if (typeof required !== "boolean") {
      assert.fail(`${label}.outputs[${index}].required must be a boolean`);
    }
    fields.push({ name, type, required });
  }
  return fields;
}

function assertDescriptorOutputs(
  outputs: readonly {
    readonly name: string;
    readonly type: string;
    readonly required?: boolean;
  }[],
  label: string,
): void {
  const names = new Set<string>();
  for (const output of outputs) {
    assert.match(
      output.name,
      /^[A-Za-z][A-Za-z0-9]*$/,
      `${label}.outputs[].name must be a stable camelCase identifier`,
    );
    assert.equal(
      names.has(output.name),
      false,
      `${label}.outputs[] has duplicate name ${output.name}`,
    );
    names.add(output.name);
    assert.ok(
      (OUTPUT_FIELD_TYPE_NAMES as readonly string[]).includes(output.type),
      `${label}.outputs.${output.name}: unsupported output type ${output.type}`,
    );
  }
}
