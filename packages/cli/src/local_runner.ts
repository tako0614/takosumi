import {
  formatTemplateRef,
  type JsonObject,
  type ManifestResource,
  parseTemplateRef,
  type PlatformContext,
  registerProvider,
  registerShape,
  type Template,
  type TemplateValidationIssue,
} from "takosumi-contract";
import {
  applyV2,
  type ApplyV2Outcome,
  destroyV2,
  type DestroyV2Outcome,
} from "@takos/takosumi-kernel/apply";
import { TAKOSUMI_BUNDLED_SHAPES } from "@takos/takosumi-plugins/shapes";
import { createInMemoryTakosumiProviders } from "@takos/takosumi-plugins/shape-providers";
import { TAKOSUMI_BUNDLED_TEMPLATES } from "@takos/takosumi-plugins/templates";

export async function applyLocal(
  resources: readonly ManifestResource[],
): Promise<ApplyV2Outcome> {
  registerLocalRegistry();
  const context = createMinimalContext();
  return await applyV2({ resources, context });
}

/**
 * Tear down resources in reverse DAG order against the in-memory bundled
 * providers. Mirrors {@link applyLocal}: same registry / same noop platform
 * context. Local mode does not persist apply records, so destroy operates
 * "by computed handle" — for the bundled in-memory and filesystem providers
 * the handle is derived from the resource name, so passing the resource name
 * as the handle reaches the same record that {@link applyLocal} created.
 */
export async function destroyLocal(
  resources: readonly ManifestResource[],
): Promise<DestroyV2Outcome> {
  registerLocalRegistry();
  const context = createMinimalContext();
  return await destroyV2({ resources, context });
}

/**
 * Resolve a manifest down to the concrete resource list that
 * {@link applyLocal} / {@link destroyLocal} consume.
 *
 * Accepts either:
 *  - `{ resources: ManifestResource[] }` — returned as-is.
 *  - `{ template: { template: "id@version", inputs?: {} } }` — kernel-style
 *    invocation (matches `apiVersion: takosumi.com/hosting/v1` manifests
 *    produced by `takosumi init`).
 *  - `{ template: { name: "id", inputs?: {} } }` — friendlier alternate
 *    shape: looks up `name` against the bundled templates by id (matching
 *    the latest version that is bundled).
 *
 * Throws a descriptive `Error` listing the bundled template ids when the
 * manifest matches none of the above.
 */
export function expandManifestLocal(
  manifest: unknown,
): readonly ManifestResource[] {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(describeMissingShapeError());
  }
  const m = manifest as Record<string, unknown>;
  if (Array.isArray(m.resources)) {
    return m.resources as readonly ManifestResource[];
  }

  if (
    typeof m.template === "object" &&
    m.template !== null &&
    !Array.isArray(m.template)
  ) {
    const invocation = m.template as Record<string, unknown>;
    const inputsRaw = invocation.inputs ?? {};
    const inputs: JsonObject =
      typeof inputsRaw === "object" && inputsRaw !== null &&
        !Array.isArray(inputsRaw)
        ? (inputsRaw as JsonObject)
        : {};

    const template = resolveBundledTemplate(invocation);
    if (!template) {
      throw new Error(describeUnknownTemplateError(invocation));
    }

    const issues: TemplateValidationIssue[] = [];
    template.validateInputs(inputs, issues);
    if (issues.length > 0) {
      const summary = issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ");
      throw new Error(
        `template '${formatTemplateRef(template.id, template.version)}' ` +
          `input validation failed: ${summary}`,
      );
    }
    return template.expand(inputs);
  }

  throw new Error(describeMissingShapeError());
}

function resolveBundledTemplate(
  invocation: Record<string, unknown>,
): Template | undefined {
  // Kernel-style: `template: { template: "id@version", ... }`.
  if (
    typeof invocation.template === "string" &&
    invocation.template.length > 0
  ) {
    const ref = invocation.template;
    const parsed = parseTemplateRef(ref);
    if (parsed) {
      const exact = TAKOSUMI_BUNDLED_TEMPLATES.find(
        (t) => t.id === parsed.id && t.version === parsed.version,
      );
      if (exact) return exact;
    }
    // Allow bare ids (no `@version`) by falling through to id lookup.
    return TAKOSUMI_BUNDLED_TEMPLATES.find((t) => t.id === ref);
  }
  // Friendlier alternate: `template: { name: "id", ... }` — first match
  // wins, which is fine for a v0 self-host CLI (the bundled set ships at
  // most one version per id).
  if (typeof invocation.name === "string" && invocation.name.length > 0) {
    return TAKOSUMI_BUNDLED_TEMPLATES.find((t) => t.id === invocation.name);
  }
  return undefined;
}

function describeMissingShapeError(): string {
  const names = bundledTemplateNames();
  return (
    "manifest must contain either `resources: [...]` (array of " +
    "ManifestResource) or `template: { template: \"id@version\", inputs? }` " +
    "/ `template: { name: \"id\", inputs? }`. Bundled local-mode templates: " +
    (names.length > 0 ? names.join(", ") : "(none)")
  );
}

function describeUnknownTemplateError(
  invocation: Record<string, unknown>,
): string {
  const requested = typeof invocation.template === "string"
    ? invocation.template
    : typeof invocation.name === "string"
    ? invocation.name
    : "(missing)";
  const names = bundledTemplateNames();
  return (
    `unknown template '${requested}'. Bundled local-mode templates: ` +
    (names.length > 0 ? names.join(", ") : "(none)")
  );
}

function bundledTemplateNames(): readonly string[] {
  return TAKOSUMI_BUNDLED_TEMPLATES.map((t) =>
    formatTemplateRef(t.id, t.version)
  );
}

function registerLocalRegistry(): void {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) registerShape(shape);
  for (const provider of createInMemoryTakosumiProviders()) {
    registerProvider(provider);
  }
}

function createMinimalContext(): PlatformContext {
  return {
    tenantId: "local",
    spaceId: "local",
    secrets: createNoopSecrets(),
    observability: createNoopObservability(),
    kms: createNoopKms(),
    objectStorage: createNoopObjectStorage(),
    refResolver: { resolve: (expr: string) => expr },
    resolvedOutputs: new Map(),
  } as unknown as PlatformContext;
}

function createNoopSecrets(): unknown {
  return {
    putSecret: () => Promise.resolve(),
    getSecret: () => Promise.resolve(undefined),
    deleteSecret: () => Promise.resolve(),
  };
}

function createNoopObservability(): unknown {
  return {
    appendAudit: (event: unknown) =>
      Promise.resolve({ sequence: 0, event, previousHash: "0", hash: "0" }),
    listAudit: () => Promise.resolve([]),
    verifyAuditChain: () => Promise.resolve(true),
    recordMetric: (event: unknown) => Promise.resolve(event),
    listMetrics: () => Promise.resolve([]),
  };
}

function createNoopKms(): unknown {
  return {
    activeKeyRef: () => Promise.resolve("noop:key"),
    encrypt: (input: { plaintext: Uint8Array }) =>
      Promise.resolve({ ciphertext: input.plaintext, keyRef: "noop:key" }),
    decrypt: (input: { ciphertext: Uint8Array }) =>
      Promise.resolve({ plaintext: input.ciphertext }),
    rotate: () => Promise.resolve("noop:key"),
  };
}

function createNoopObjectStorage(): unknown {
  return {
    putObject: () =>
      Promise.resolve({
        bucket: "",
        key: "",
        contentLength: 0,
        digest: { algorithm: "sha256", value: "" },
      }),
    getObject: () => Promise.resolve(undefined),
    headObject: () => Promise.resolve(undefined),
    deleteObject: () => Promise.resolve(false),
    listBuckets: () => Promise.resolve([]),
  };
}
