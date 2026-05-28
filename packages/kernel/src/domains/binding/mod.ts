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

import type {
  AppSpec,
  BindingOptions,
  ListenOptions,
} from "takosumi-contract/app-spec";
import type {
  EnvInjection,
  InlineMaterializer,
  KernelPlugin,
  OutputMaterial,
  ResolvedInputBinding,
} from "takosumi-contract/reference/plugin";

export type ResolvedBinding = ResolvedInputBinding;

/**
 * Closed-envelope error code surface emitted by {@link BindingResolver}.
 *
 * Codes are stable and meant to drive installer / Installer API closed-error
 * envelopes — they map onto the `failed_precondition` / `invalid_argument`
 * categories used by the Installer surface.
 */
export type BindingResolutionErrorCode =
  | "binding_required_material_missing"
  | "binding_listen_missing_selector"
  | "material_kind_mismatch";

/**
 * Closed-envelope error thrown when {@link BindingResolver} cannot resolve a
 * binding edge without violating the AppSpec contract — for example a
 * `required: true` `listen` whose material is absent, or a `listen.kind`
 * selector resolved against a material whose advertised `kind` differs.
 */
export class BindingResolutionError extends Error {
  readonly code: BindingResolutionErrorCode;
  readonly details: Readonly<Record<string, string>>;
  constructor(
    code: BindingResolutionErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "BindingResolutionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

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
   * material registry. Exact listens use `path`; discovery listens select by
   * `kind` + optional labels and use a stable synthetic source ref derived
   * from `kind`. Returns one {@link ResolvedBinding} per consumer / binding
   * pair.
   *
   * Missing material handling:
   *   - `connect.*` always carries `output: component.outputSlot`. If the
   *     same-AppSpec material is missing, `connect` is treated as
   *     implicitly required and throws `binding_required_material_missing`
   *     because component output edges are part of the deterministic
   *     wiring contract.
   *   - `listen.*` carries an explicit `required?: boolean` flag. When
   *     `required: true`, a missing material throws
   *     `binding_required_material_missing`; otherwise the edge is
   *     silently skipped and a structured warning is logged.
   *
   * Listen `kind` validation: when `listen.<binding>.kind` is set, the
   * resolved material must advertise the same `kind` field (or the
   * declared kind may be `*` to opt into wildcard matching).
   */
  async resolveAppSpec(
    appSpec: AppSpec,
    materials: Readonly<Record<string, OutputMaterial>>,
  ): Promise<readonly ResolvedBinding[]> {
    const out: ResolvedBinding[] = [];
    for (
      const [componentName, component] of Object.entries(appSpec.components)
    ) {
      type Edge = {
        readonly bindingName: string;
        readonly sourceRef: string;
        readonly options: BindingOptions;
        readonly isListen: boolean;
      };
      const edges: Edge[] = [
        ...Object.entries(component.connect ?? {}).map(
          ([bindingName, options]): Edge => ({
            bindingName,
            sourceRef: options.output,
            options,
            isListen: false,
          }),
        ),
        ...Object.entries(component.listen ?? {}).map(
          ([bindingName, options]): Edge => ({
            bindingName,
            sourceRef: listenSourceRef(options, {
              componentName,
              bindingName,
            }),
            options,
            isListen: true,
          }),
        ),
      ];
      for (const edge of edges) {
        const { bindingName, sourceRef, options, isListen } = edge;
        const material = materials[sourceRef];
        if (!material) {
          const required = isListen
            ? (options as ListenOptions).required === true
            : true;
          if (required) {
            throw new BindingResolutionError(
              "binding_required_material_missing",
              `${componentName}.${
                isListen ? "listen" : "connect"
              }.${bindingName} requires material ${
                JSON.stringify(sourceRef)
              } ` +
                `but no entry was provided`,
              {
                component: componentName,
                bindingKind: isListen ? "listen" : "connect",
                bindingName,
                sourceRef,
              },
            );
          }
          // Optional listen with no material — skip but emit a structured
          // warning so operators can detect drift between AppSpec listen
          // selectors and the published platform service inventory.
          this.#warnMissingOptionalListen({
            component: componentName,
            bindingName,
            sourceRef,
          });
          continue;
        }
        if (isListen) {
          assertListenMaterialKind({
            component: componentName,
            bindingName,
            options: options as ListenOptions,
            sourceRef,
            material,
          });
        }
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

  #warnMissingOptionalListen(detail: {
    readonly component: string;
    readonly bindingName: string;
    readonly sourceRef: string;
  }): void {
    console.warn(
      "[takosumi-kernel] binding.optional_listen_missing_material",
      JSON.stringify({
        event: "binding.optional_listen_missing_material",
        component: detail.component,
        bindingName: detail.bindingName,
        sourceRef: detail.sourceRef,
      }),
    );
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
 * Build the synthetic source ref for a listen edge. Closed-envelope guard:
 * a listen with neither `path` nor `kind` cannot be resolved deterministically
 * against the Space material registry, so the resolver throws
 * `binding_listen_missing_selector` instead of silently producing the
 * historical `"kind:unknown"` sentinel.
 *
 * Callers that need the ref outside the AppSpec walker pass the
 * `componentName` / `bindingName` so the error message points to the
 * offending AppSpec entry.
 */
function listenSourceRef(
  options: BindingOptions,
  context?: { readonly componentName?: string; readonly bindingName?: string },
): string {
  if ("path" in options && typeof options.path === "string") {
    return options.path;
  }
  if ("kind" in options && typeof options.kind === "string") {
    return `kind:${options.kind}`;
  }
  const where = context?.componentName && context.bindingName
    ? `${context.componentName}.listen.${context.bindingName}`
    : "listen binding";
  throw new BindingResolutionError(
    "binding_listen_missing_selector",
    `${where} must declare either \`path\` or \`kind\` as its selector`,
    {
      ...(context?.componentName ? { component: context.componentName } : {}),
      ...(context?.bindingName ? { bindingName: context.bindingName } : {}),
    },
  );
}

/**
 * Validate the resolved material against the declared `listen.kind` selector.
 *
 * AppSpec contract: when `listen.<binding>.kind` is set, the consumer is
 * asserting the resolved material's `kind` field equals that value. The
 * special selector `"*"` opts into wildcard matching for callers that need
 * to listen to any material kind. When the material does not advertise a
 * `kind` field at all, we treat it as `unknown` and let the mismatch fire.
 */
function assertListenMaterialKind(input: {
  readonly component: string;
  readonly bindingName: string;
  readonly options: ListenOptions;
  readonly sourceRef: string;
  readonly material: OutputMaterial;
}): void {
  const declared = input.options.kind;
  if (typeof declared !== "string" || declared.length === 0) return;
  if (declared === "*") return;
  const actual = readMaterialKind(input.material);
  if (actual === declared) return;
  throw new BindingResolutionError(
    "material_kind_mismatch",
    `${input.component}.listen.${input.bindingName} expects kind ` +
      `${JSON.stringify(declared)} but material at ${
        JSON.stringify(input.sourceRef)
      } advertises kind ${JSON.stringify(actual ?? "unknown")}`,
    {
      component: input.component,
      bindingName: input.bindingName,
      sourceRef: input.sourceRef,
      expectedKind: declared,
      actualKind: actual ?? "unknown",
    },
  );
}

function readMaterialKind(material: OutputMaterial): string | undefined {
  const value = (material as Record<string, unknown>).kind;
  return typeof value === "string" ? value : undefined;
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
