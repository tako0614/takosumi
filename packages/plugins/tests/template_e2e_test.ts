import assert from "node:assert/strict";
import {
  capabilitySubsetIssues,
  extractRefs,
  extractRefsFromValue,
  getProvider,
  getShapeByRef,
  type JsonObject,
  type JsonValue,
  type ManifestResource,
  parseRef,
  type PlatformContext,
  registerProvider,
  registerShape,
  type ResolvedRef,
  type ShapeValidationIssue,
  unregisterProvider,
  unregisterShape,
} from "takosumi-contract";
import { TAKOSUMI_BUNDLED_SHAPES } from "../src/shapes/mod.ts";
import { createInMemoryTakosumiProviders } from "../src/shape-providers/mod.ts";
import { SelfhostedSingleVmTemplate } from "../src/templates/selfhosted-single-vm.ts";

const ctx = {} as PlatformContext;

interface AppliedRecord {
  readonly name: string;
  readonly handle: string;
  readonly outputs: JsonObject;
}

async function applyResources(
  resources: readonly ManifestResource[],
): Promise<AppliedRecord[]> {
  const outputsByName = new Map<string, JsonObject>();
  const applied: AppliedRecord[] = [];
  for (const resource of resources) {
    const shape = getShapeByRef(resource.shape);
    assert.ok(shape, `shape not registered: ${resource.shape}`);
    const providerId = resource.provider;
    assert.ok(providerId, `provider missing for resource: ${resource.name}`);
    const provider = getProvider(providerId);
    assert.ok(provider, `provider not registered: ${providerId}`);
    assert.equal(provider.implements.id, shape.id);

    const resolvedSpec = resolveRefs(resource.spec, outputsByName);
    const specIssues: ShapeValidationIssue[] = [];
    shape.validateSpec(resolvedSpec, specIssues);
    assert.deepEqual(
      specIssues,
      [],
      `${resource.name} spec invalid: ${JSON.stringify(specIssues)}`,
    );

    const result = await provider.apply(resolvedSpec as JsonObject, ctx);
    outputsByName.set(resource.name, result.outputs as JsonObject);
    applied.push({
      name: resource.name,
      handle: result.handle,
      outputs: result.outputs as JsonObject,
    });
  }
  return applied;
}

function resolveRefs(
  value: JsonValue,
  outputs: ReadonlyMap<string, JsonObject>,
): JsonValue {
  if (typeof value === "string") {
    const full = parseRef(value);
    if (full) return resolveSingle(full, outputs, value);
    const refs = extractRefs(value);
    if (refs.length === 0) return value;
    return value.replace(
      /\$\{(ref|secret-ref):([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)\}/g,
      (raw: string, kind: string, source: string, field: string) => {
        const resolved = resolveSingle(
          {
            kind: kind === "secret-ref" ? "secret-ref" : "ref",
            source,
            field,
          },
          outputs,
          raw,
        );
        return typeof resolved === "string"
          ? resolved
          : JSON.stringify(resolved);
      },
    );
  }
  if (Array.isArray(value)) return value.map((e) => resolveRefs(e, outputs));
  if (value !== null && typeof value === "object") {
    const next: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = resolveRefs(v, outputs);
    }
    return next;
  }
  return value;
}

function resolveSingle(
  ref: ResolvedRef,
  outputs: ReadonlyMap<string, JsonObject>,
  fallback: string,
): string {
  if (ref.kind === "secret-ref") return fallback;
  const sourceOutputs = outputs.get(ref.source);
  if (!sourceOutputs) return fallback;
  const v = sourceOutputs[ref.field];
  if (v === undefined) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function setUp() {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) registerShape(shape);
  const providers = createInMemoryTakosumiProviders();
  for (const provider of providers) registerProvider(provider);
  return providers;
}

function tearDown(providers: readonly { id: string }[]) {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) {
    unregisterShape(shape.id, shape.version);
  }
  for (const provider of providers) unregisterProvider(provider.id);
}

Deno.test("e2e: SelfhostedSingleVm template expands and applies end-to-end", async () => {
  const providers = setUp();
  try {
    const resources = SelfhostedSingleVmTemplate.expand({
      serviceName: "api",
      image: "oci://example/api:latest",
      port: 8080,
      domain: "api.example.com",
    });
    assert.equal(resources.length, 4);

    for (const resource of resources) {
      const refs = extractRefsFromValue(resource.spec);
      for (const ref of refs) {
        if (ref.kind !== "ref") continue;
        const referencedShape = resources.find((r) => r.name === ref.source)
          ?.shape;
        assert.ok(
          referencedShape,
          `${resource.name}.${ref.source}.${ref.field} references unknown resource`,
        );
        const sourceShape = getShapeByRef(referencedShape);
        assert.ok(sourceShape);
        assert.ok(
          sourceShape.outputFields.includes(ref.field),
          `${ref.source}.${ref.field} not in shape outputs ${
            sourceShape.outputFields.join(",")
          }`,
        );
      }
    }

    const applied = await applyResources(resources);
    assert.equal(applied.length, 4);
    const api = applied.find((a) => a.name === "api")!;
    assert.match(String(api.outputs.url), /^http:\/\/localhost:\d+$/);
    const domain = applied.find((a) => a.name === "domain")!;
    assert.equal(domain.outputs.fqdn, "api.example.com");
  } finally {
    tearDown(providers);
  }
});

Deno.test("e2e: capability subset is enforced when manifest requires unsupported caps", () => {
  const providers = setUp();
  try {
    const fargate = providers.find((p) => p.id === "@takos/aws-fargate")!;
    const issues = capabilitySubsetIssues(
      ["scale-to-zero"],
      fargate.capabilities,
      "$.requires",
    );
    assert.ok(issues.length > 0, "fargate does not support scale-to-zero");
    const cloudRun = providers.find((p) => p.id === "@takos/gcp-cloud-run")!;
    const cloudRunIssues = capabilitySubsetIssues(
      ["scale-to-zero"],
      cloudRun.capabilities,
      "$.requires",
    );
    assert.deepEqual(cloudRunIssues, []);
  } finally {
    tearDown(providers);
  }
});
