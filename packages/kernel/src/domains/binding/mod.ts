/**
 * Binding domain — resolves AppSpec listen bindings into runtime
 * injection.
 *
 * For each `Component.listen[<bindingName>]`,
 * the resolver fetches the published material from the registry, asks the
 * listener plugin's optional `applyListen` hook for an `EnvInjection`
 * descriptor, and otherwise falls back to a kernel default that expands
 * material fields into prefixed env vars (mirroring the
 * `as: env` / `prefix: FOO` listen shape).
 *
 * The resolver is intentionally side-effect-free: it returns a list of
 * {@link ResolvedBinding} descriptors that the {@link InstallerPipeline}
 * then attaches to the listener's runtime via plugin.apply()'s
 * `listenedMaterials` context.
 */

import type { AppSpec, ListenOptions } from "takosumi-contract/app-spec";
import type {
  EnvInjection,
  InlineMaterializer,
  KernelPlugin,
  NamespaceMaterial,
  ResolvedListenBinding,
} from "takosumi-contract/reference/plugin";

export type ResolvedBinding = ResolvedListenBinding;

/**
 * Look up the materializer (KernelPlugin or InlineMaterializer) responsible
 * for a given `Component.kind`. The resolver delegates the listener-side
 * mapping to that materializer's `applyListen` hook when present.
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
   * Resolve every listen binding in `appSpec` against the supplied material
   * registry. Returns one {@link ResolvedBinding} per listener / binding
   * pair. Entries whose source ref is missing from `materials` are silently
   * skipped; callers decide whether a missing local source is fatal.
   */
  async resolveAppSpec(
    appSpec: AppSpec,
    materials: Readonly<Record<string, NamespaceMaterial>>,
  ): Promise<readonly ResolvedBinding[]> {
    const out: ResolvedBinding[] = [];
    for (
      const [componentName, component] of Object.entries(appSpec.components)
    ) {
      const listen = component.listen;
      if (!listen) continue;
      for (const [bindingName, options] of Object.entries(listen)) {
        const material = materials[options.from];
        if (!material) continue;
        const binding = await this.resolveEdge({
          installationId: "",
          listenerComponent: componentName,
          listenerKind: component.kind,
          listenerComponentRef: component,
          bindingName,
          sourceRef: options.from,
          options,
          material,
        });
        out.push(binding);
      }
    }
    return out;
  }

  /**
   * Resolve a single listen edge — invoke the listener materializer's
   * `applyListen` hook when present, otherwise apply the kernel default
   * (env-prefix expansion).
   */
  async resolveEdge(input: {
    readonly installationId: string;
    readonly listenerComponent: string;
    readonly listenerKind: string;
    readonly listenerComponentRef: AppSpec["components"][string];
    readonly bindingName: string;
    readonly sourceRef: string;
    readonly options: ListenOptions;
    readonly material: NamespaceMaterial;
  }): Promise<ResolvedBinding> {
    const materializer = this.#findMaterializer?.(input.listenerKind);
    let injection: EnvInjection;
    if (materializer && typeof materializer.applyListen === "function") {
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
 * Reference fallback {@link EnvInjection} for a listen binding. Operator
 * descriptor metadata or implementation bindings may override this projection;
 * JSON-LD is only one metadata format a distribution can use.
 *
 *   - `as: env`    → expand every material field into `${PREFIX}_${FIELD}` when
 *                    `prefix` is set, or bare `${FIELD}` when it is omitted.
 *                    FIELD is upper-snake of the material key.
 *   - `as: secret-env` → use the same rule while preserving secretRef values in
 *                    the resolved binding record. Secret ref material fields
 *                    such as `clientSecretRef` drop the trailing `Ref` in the
 *                    env key (`CLIENT_SECRET`).
 *   - `as: config-mount` → return the material as a mount descriptor under
 *                    `options.mount` (or `/` when absent).
 *   - `as: upstream` / `as: target` → return the material as an upstream
 *                    target descriptor.
 *   - operator-defined shape → fall back to env expansion.
 */
export function defaultEnvInjection(
  options: ListenOptions,
  material: NamespaceMaterial,
): EnvInjection {
  switch (options.as) {
    case "config-mount": {
      const mountPath = options.mount ?? "/";
      return {
        mounts: { [mountPath]: serializeMaterialForMount(material) },
      };
    }
    case "target":
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
  material: NamespaceMaterial,
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
  value: NamespaceMaterial[string],
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
  material: NamespaceMaterial,
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
  value: NamespaceMaterial[string],
): value is { readonly secretRef: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return typeof (value as { readonly secretRef?: unknown }).secretRef ===
    "string";
}
