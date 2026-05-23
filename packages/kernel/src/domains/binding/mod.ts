/**
 * Binding domain — resolves namespace pub/sub listen edges into runtime
 * injection.
 *
 * Phase C implementation. For each `Component.listen[<namespacePath>]`,
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
} from "takosumi-contract/plugin";

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
   * Resolve every listen edge in `appSpec` against the supplied namespace
   * registry. Returns one {@link ResolvedBinding} per listener / path pair.
   * Listen entries whose namespace path is missing from `materials` are
   * silently skipped — the installer treats absent publishers as
   * "external" and lets the listener decide whether to fail.
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
      for (const [nsPath, options] of Object.entries(listen)) {
        const material = materials[nsPath];
        if (!material) continue;
        const binding = await this.resolveEdge({
          installationId: "",
          listenerComponent: componentName,
          listenerKind: component.kind,
          listenerComponentRef: component,
          namespacePath: nsPath,
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
    readonly namespacePath: string;
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
        namespacePath: input.namespacePath,
        options: input.options,
        material: input.material,
      });
    } else {
      injection = defaultEnvInjection(input.options, input.material);
    }
    return {
      listenerComponent: input.listenerComponent,
      namespacePath: input.namespacePath,
      options: input.options,
      envInjections: injection.env ?? {},
      mounts: injection.mounts,
      target: injection.target,
      material: input.material,
    };
  }
}

/**
 * Kernel default {@link EnvInjection} for a listen edge. Implements the
 * `as: env` shape declared in the kind JSON-LD `envMap`:
 *
 *   - `as: env`    → expand every material field into `${PREFIX}_${FIELD}`
 *                    (PREFIX = `options.prefix` or upper-cased namespace
 *                    leaf when `prefix` is omitted; FIELD = upper-snake
 *                    of the material key).
 *   - `as: mount`  → return the material as a mount descriptor under
 *                    `options.mount` (or the namespace path when absent).
 *   - `as: target` → return the material as a target descriptor.
 *   - operator-defined shape → fall back to env expansion.
 */
export function defaultEnvInjection(
  options: ListenOptions,
  material: NamespaceMaterial,
): EnvInjection {
  switch (options.as) {
    case "mount": {
      const mountPath = options.mount ?? "/";
      return {
        mounts: { [mountPath]: serializeMaterialForMount(material) },
      };
    }
    case "target":
      return { target: material };
    case "env":
    default:
      return { env: expandMaterialAsEnv(material, options.prefix) };
  }
}

function expandMaterialAsEnv(
  material: NamespaceMaterial,
  prefix: string | undefined,
): Readonly<Record<string, string | { readonly secretRef: string }>> {
  const out: Record<string, string | { readonly secretRef: string }> = {};
  const normalizedPrefix = (prefix ?? "").trim();
  for (const [field, value] of Object.entries(material)) {
    const envKey = composeEnvKey(normalizedPrefix, field);
    out[envKey] = value;
  }
  return out;
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
    else parts.push(`${field}=$secret(${value.secretRef})`);
  }
  return parts.sort().join("\n");
}
