/**
 * Binding domain — resolves AppSpec connect / listen inputs into runtime
 * injection.
 *
 * For each `Component.connect[<bindingName>]` or
 * `Component.listen[<bindingName>]`,
 * the resolver fetches the material from the registry, asks the
 * consumer materializer's optional `applyBinding` hook for an `EnvInjection`
 * descriptor, and otherwise falls back to a kernel default that expands
 * material fields into prefixed env vars (mirroring the
 * `inject: env` / `prefix: FOO` binding shape).
 *
 * The resolver is intentionally side-effect-free: it returns a list of
 * {@link ResolvedBinding} descriptors that the {@link InstallerPipeline}
 * then attaches to the consumer's runtime via plugin.apply()'s
 * `inputMaterials` / `listenedMaterials` context.
 */

import type { AppSpec, BindingOptions } from "takosumi-contract/app-spec";
import type {
  EnvInjection,
  InlineMaterializer,
  KernelPlugin,
  OutputMaterial,
  ResolvedInputBinding,
} from "takosumi-contract/reference/plugin";

export type ResolvedBinding = ResolvedInputBinding;

/**
 * Look up the materializer (KernelPlugin or InlineMaterializer) responsible
 * for a given `Component.kind`. The resolver delegates the consumer-side
 * mapping to that materializer's `applyBinding` hook when present.
 */
export type MaterializerLookup = (
  componentKind: string,
) => KernelPlugin | InlineMaterializer | undefined;

export interface BindingResolverDependencies {
  /** Optional plugin lookup. When omitted, kernel default mapping is used. */
  readonly findMaterializer?: MaterializerLookup;
}

export class BindingResolver {
  readonly #findMaterializer?: MaterializerLookup;

  constructor(dependencies: BindingResolverDependencies = {}) {
    this.#findMaterializer = dependencies.findMaterializer;
  }

  /**
   * Resolve every connect/listen input in `appSpec` against the supplied
   * material registry. Returns one {@link ResolvedBinding} per consumer /
   * binding
   * pair. Entries whose source ref is missing from `materials` are silently
   * skipped; callers decide whether a missing local source is fatal.
   */
  async resolveAppSpec(
    appSpec: AppSpec,
    materials: Readonly<Record<string, OutputMaterial>>,
  ): Promise<readonly ResolvedBinding[]> {
    const out: ResolvedBinding[] = [];
    for (
      const [componentName, component] of Object.entries(appSpec.components)
    ) {
      const entries = [
        ...Object.entries(component.connect ?? {}).map((
          [bindingName, options],
        ) => [bindingName, options.output, options] as const),
        ...Object.entries(component.listen ?? {}).map((
          [bindingName, options],
        ) => [bindingName, options.path, options] as const),
      ];
      for (const [bindingName, sourceRef, options] of entries) {
        const material = materials[sourceRef];
        if (!material) continue;
        const binding = await this.resolveEdge({
          installationId: "",
          listenerComponent: componentName,
          listenerKind: component.kind,
          listenerComponentRef: component,
          bindingName,
          sourceRef,
          options,
          material,
        });
        out.push(binding);
      }
    }
    return out;
  }

  /**
   * Resolve a single input edge — invoke the consumer materializer's
   * `applyBinding` hook when present, otherwise apply the legacy
   * `applyListen` hook or the kernel default
   * (env-prefix expansion).
   */
  async resolveEdge(input: {
    readonly installationId: string;
    readonly listenerComponent: string;
    readonly listenerKind: string;
    readonly listenerComponentRef: AppSpec["components"][string];
    readonly bindingName: string;
    readonly sourceRef: string;
    readonly options: BindingOptions;
    readonly material: OutputMaterial;
  }): Promise<ResolvedBinding> {
    const materializer = this.#findMaterializer?.(input.listenerKind);
    let injection: EnvInjection;
    if (materializer && typeof materializer.applyBinding === "function") {
      injection = await materializer.applyBinding({
        installationId: input.installationId,
        componentName: input.listenerComponent,
        component: input.listenerComponentRef,
        bindingName: input.bindingName,
        sourceRef: input.sourceRef,
        options: input.options,
        material: input.material,
      });
    } else if (materializer && typeof materializer.applyListen === "function") {
      injection = await materializer.applyListen({
        installationId: input.installationId,
        componentName: input.listenerComponent,
        component: input.listenerComponentRef,
        bindingName: input.bindingName,
        sourceRef: input.sourceRef,
        options: input.options,
        material: input.material,
      });
    } else {
      injection = defaultEnvInjection(input.options, input.material);
    }
    return {
      listenerComponent: input.listenerComponent,
      bindingName: input.bindingName,
      sourceRef: input.sourceRef,
      options: input.options,
      envInjections: injection.env ?? {},
      mounts: injection.mounts,
      target: injection.target,
      material: input.material,
    };
  }
}

/**
 * Reference fallback {@link EnvInjection} for an input binding. Operator
 * descriptor metadata or implementation bindings may override this projection;
 * JSON-LD is only one metadata format a distribution can use.
 *
 *   - `inject: env`    → expand every material field into `${PREFIX}_${FIELD}` when
 *                    `prefix` is set, or bare `${FIELD}` when it is omitted.
 *                    FIELD is upper-snake of the material key.
 *   - `inject: secret-env` → use the same rule while preserving secretRef values in
 *                    the resolved binding record. Secret ref material fields
 *                    such as `clientSecretRef` drop the trailing `Ref` in the
 *                    env key (`CLIENT_SECRET`).
 *   - `inject: config-mount` → return the material as a mount descriptor under
 *                    `options.mount` (or `/` when absent).
 *   - `inject: upstream` → return the material as an upstream
 *                    target descriptor.
 *   - operator-defined shape → fall back to env expansion.
 */
export function defaultEnvInjection(
  options: BindingOptions,
  material: OutputMaterial,
): EnvInjection {
  switch (options.inject) {
    case "config-mount": {
      const mountPath = options.mount ?? "/";
      return {
        mounts: { [mountPath]: serializeMaterialForMount(material) },
      };
    }
    case "upstream":
      return { target: material };
    case "secret-env":
      return {
        env: expandMaterialAsEnv(material, options.prefix, {
          stripSecretRefSuffix: true,
        }),
      };
    case "env":
    default:
      return { env: expandMaterialAsEnv(material, options.prefix) };
  }
}

function expandMaterialAsEnv(
  material: OutputMaterial,
  prefix: string | undefined,
  options: { readonly stripSecretRefSuffix?: boolean } = {},
): Readonly<Record<string, string | { readonly secretRef: string }>> {
  const out: Record<string, string | { readonly secretRef: string }> = {};
  const normalizedPrefix = (prefix ?? "").trim();
  for (const [field, value] of Object.entries(material)) {
    const envField = options.stripSecretRefSuffix && isSecretRefMaterial(value)
      ? stripSecretRefSuffix(field)
      : field;
    const envKey = composeEnvKey(normalizedPrefix, envField);
    out[envKey] = materialValueToEnv(value);
  }
  return out;
}

function materialValueToEnv(
  value: OutputMaterial[string],
): string | { readonly secretRef: string } {
  if (isSecretRefMaterial(value)) return { secretRef: value.secretRef };
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function composeEnvKey(prefix: string, field: string): string {
  const upperField = toUpperSnake(field);
  if (prefix.length === 0) return upperField;
  return `${toUpperSnake(prefix)}_${upperField}`;
}

function toUpperSnake(value: string): string {
  // Convert camelCase / kebab-case / dot.case to UPPER_SNAKE_CASE.
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.]/g, "_")
    .toUpperCase();
}

function stripSecretRefSuffix(value: string): string {
  if (value.endsWith("Ref") && value.length > "Ref".length) {
    return value.slice(0, -"Ref".length);
  }
  return value;
}

function serializeMaterialForMount(
  material: OutputMaterial,
): string {
  // The kernel doesn't write file contents — the mount string is opaque
  // to the kernel and surfaced as-is in the runtime injection record.
  // We serialize fields in deterministic order so downstream consumers
  // get a stable representation.
  const parts: string[] = [];
  for (const [field, value] of Object.entries(material)) {
    if (typeof value === "string") parts.push(`${field}=${value}`);
    else if (isSecretRefMaterial(value)) {
      parts.push(`${field}=$secret(${value.secretRef})`);
    } else {
      parts.push(`${field}=${JSON.stringify(value)}`);
    }
  }
  return parts.sort().join("\n");
}

function isSecretRefMaterial(
  value: OutputMaterial[string],
): value is { readonly secretRef: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return typeof (value as { readonly secretRef?: unknown }).secretRef ===
    "string";
}
