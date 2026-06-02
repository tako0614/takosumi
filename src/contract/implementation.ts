/**
 * OperatorImplementation — the reference Takosumi service's Vite-style plain-array
 * materializer API for reference implementation component output and input
 * material wiring.
 *
 * An `OperatorImplementation` advertises one or more component kind URIs in `provides`,
 * may expose short-name `aliases` for operator tooling,
 * materializes those components via `apply()`, projects component output slots
 * into output material via `materializeOutput()`, and surfaces input materials
 * into the component runtime via `applyBinding()`.
 *
 * The reference implementation wires implementations as a plain array to
 * `createTakosumiService({ implementations })`, matching the plain-array implementation authoring
 * experience. A Takosumi-compatible implementation can bind the same backend
 * adapter through another mechanism. This is implementation wiring, not the
 * manifestless v1 public Source contract.
 *
 * # Materializer abstraction
 *
 * An `OperatorImplementation` is one packaging of a more general concept: a
 * **Materializer** is any code that turns a kind URI into a concrete
 * resource and emits / consumes materials. Inline functions and
 * operator-defined raw code can attach to the same service surface as
 * full implementations via {@link InlineMaterializer}.
 */
import type {
  Deployment,
  Installation,
  SourceSummary,
} from "./installer-api.ts";
import {
  isOfficialMaterialKindName,
  validateOfficialMaterial,
} from "./catalog.ts";
import type { JsonObject, JsonValue } from "./types.ts";

export type BindingName = string;
export type OutputSlotName = string;
export type ListenSourceRef = string;

export interface BindingOptions {
  readonly inject?: string | JsonObject;
  readonly prefix?: string;
  readonly mount?: string;
}

export interface Component {
  readonly kind: string;
  readonly spec?: JsonValue;
}

export interface PublishOptions {
  readonly kind?: string;
  readonly path?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface OperatorImplementation {
  /** Operator-scoped implementation id, e.g. `"operator.takosumi.provider.cloudflare-worker"`. */
  readonly name: string;
  readonly version: string;
  /**
   * Operator-resolved kind URIs this implementation can materialize.
   * The installer resolves `Component.kind` through the operator alias map
   * and matches the resulting URI against `provides[]` during `apply`.
   * JSON-LD is the takosumi.com reference descriptor metadata format, not a
   * required authority for every implementation.
   *
   * Examples:
   *   - `["https://takosumi.com/kinds/v1/worker"]` (takosumi.com reference descriptor)
   *   - `["https://example.com/kinds/lambda"]` (operator-defined)
   */
  readonly provides: readonly string[];

  /**
   * Short-name aliases a distribution may expose for `Component.kind` in
   * addition to the canonical URIs in `provides[]`. Alias resolution is an
   * operator-owned map from author-friendly names to kind URIs.
   */
  readonly aliases?: readonly string[];

  /**
   * Free-form capability tags for operator introspection. Not interpreted
   * by the reference adapter API — surface them via tooling / dashboards if
   * useful.
   */
  readonly capabilities?: readonly string[];

  /**
   * Validate a full reference component before it is applied.
   * Native providers use this for constraints that depend on resolved binding
   * declarations rather than only `component.spec` shape.
   */
  validateComponent?(component: Component): void | Promise<void>;

  /**
   * Materialize a component into a concrete resource on the target
   * runtime. Called by `InstallerPipeline` during `apply` in connect
   * topological order. Resolved input materials are made available via
   * `inputMaterials` (`listenedMaterials` is kept as a compatibility alias).
   */
  apply(ctx: OperatorImplementationApplyContext): Promise<OperatorImplementationApplyResult>;

  /**
   * Destroy a previously-materialized component. Called on Installation
   * deletion / rollback. Optional — implementations that have no destroyable
   * state can omit this hook.
   */
  destroy?(ctx: OperatorImplementationDestroyContext): Promise<void>;

  /**
   * Observe a previously-materialized component. Optional — implementations that can
   * cheaply read backend state return a normalized status for operator
   * dashboards and repair loops.
   */
  status?(ctx: OperatorImplementationStatusContext): Promise<OperatorImplementationResourceStatus>;

  /**
   * Compute the {@link OutputMaterial} for a component output slot.
   * Invoked after `apply()` succeeds when another reference component consumes
   * that output, when an operator publication plan exposes it, or when the
   * service records implementation-visible outputs as Deployment evidence.
   *
   * Optional — kinds that do not expose output material (e.g. pure
   * consumers) may omit this hook.
   */
  materializeOutput?(
    ctx: OutputMaterialContext,
  ): Promise<OutputMaterial>;

  /**
   * @deprecated Renamed to `materializeOutput`. The installer reads
   * `materializeOutput ?? publishMaterial`, so this alias only exists to accept
   * pre-rename implementations. Remove once no operator implementation defines
   * `publishMaterial`.
   */
  publishMaterial?(
    ctx: OutputMaterialContext,
  ): Promise<OutputMaterial>;

  /**
   * Surface a connected or listened {@link OutputMaterial} into the
   * component runtime as an env injection / mount / target descriptor. Invoked
   * once per resolved input binding before `apply()` is called for the
   * consuming component.
   *
   * Optional — kinds that do not consume input material may omit
   * this hook (the installer treats absent hooks as no-op).
   */
  applyBinding?(ctx: ApplyInputBindingContext): Promise<EnvInjection>;

  /**
   * @deprecated Renamed to `applyBinding`. The installer reads
   * `applyBinding ?? applyListen`. Remove once no operator implementation
   * and no service binding handler defines `applyListen`.
   */
  applyListen?(ctx: ApplyInputBindingContext): Promise<EnvInjection>;

  // ---------------------------------------------------------------------
  // Lifecycle hooks — Vite-style optional callbacks. All are awaited
  // serially across the implementation array in registration order.
  // ---------------------------------------------------------------------

  /** Fires before the first Deployment of a brand-new Installation. */
  onInstallStart?(ctx: OperatorImplementationInstallationContext): Promise<void>;
  /** Fires after the first Deployment of a brand-new Installation succeeds. */
  onInstallComplete?(ctx: OperatorImplementationInstallationContext): Promise<void>;
  /** Fires before every Deployment apply (including the first one). */
  onDeploymentStart?(ctx: OperatorImplementationDeploymentContext): Promise<void>;
  /** Fires after every successful Deployment apply. */
  onDeploymentComplete?(ctx: OperatorImplementationDeploymentContext): Promise<void>;
}

/**
 * Materializer = arbitrary code that materializes a kind URI and
 * participates in the component output / input material registry. {@link OperatorImplementation} is
 * the conventional packaging — `name` / `version` / lifecycle hooks — but
 * inline functions and operator-defined raw code can attach to the same
 * service surface via {@link InlineMaterializer}.
 */
export type Materializer = OperatorImplementation | InlineMaterializer;

/**
 * Minimal materializer surface — the smallest contract the installer
 * recognizes. Useful for inline materializers in tests, examples, and
 * operator-defined raw code. An `OperatorImplementation` is structurally a superset
 * of `InlineMaterializer`.
 */
export interface InlineMaterializer {
  /** Canonical kind URIs this materializer handles. */
  readonly provides: readonly string[];
  /** Optional short-name aliases supplied by operator tooling / alias maps. */
  readonly aliases?: readonly string[];
  validateComponent?(component: Component): void | Promise<void>;
  apply(ctx: OperatorImplementationApplyContext): Promise<OperatorImplementationApplyResult>;
  status?(ctx: OperatorImplementationStatusContext): Promise<OperatorImplementationResourceStatus>;
  materializeOutput?(
    ctx: OutputMaterialContext,
  ): Promise<OutputMaterial>;
  /**
   * @deprecated Renamed to `materializeOutput`; kept for pre-rename inline
   * materializers. Remove together with `OperatorImplementation.publishMaterial`.
   */
  publishMaterial?(
    ctx: OutputMaterialContext,
  ): Promise<OutputMaterial>;
  applyBinding?(ctx: ApplyInputBindingContext): Promise<EnvInjection>;
  /**
   * @deprecated Renamed to `applyBinding`; kept for pre-rename inline
   * materializers. Remove together with `OperatorImplementation.applyListen`.
   */
  applyListen?(ctx: ApplyInputBindingContext): Promise<EnvInjection>;
}

/**
 * Payload projected from a component output slot or platform service. Keys are material field names
 * (e.g. `targets`, `endpoints`, `host`) and values are non-secret JSON
 * material values or `{ secretRef }` references to entries in the operator
 * secret store.
 *
 * Treated as opaque by the service; consumers (= input-binding handlers)
 * interpret the payload through the source material contract,
 * operator descriptor metadata, and implementation binding. JSON-LD is the
 * takosumi.com reference metadata form when an operator chooses to use it.
 */
export type OutputMaterial = Readonly<
  Record<string, JsonValue | { readonly secretRef: string }>
>;

/**
 * @deprecated Renamed to {@link OutputMaterial}. Remove once no consumer in
 * operator implementation imports `PublicationMaterial`.
 */
export type PublicationMaterial = OutputMaterial;

/**
 * Result of `applyBinding()`: the env / mount / target descriptor the
 * installer should attach to the consuming component runtime.
 *
 *   - `env`    — env-var injections (literal strings or secretRefs).
 *   - `mounts` — filesystem-mount descriptors keyed by mount path.
 *   - `target` — free-form target descriptor used by router-style kinds
 *                (e.g. gateway-style materializers read an `http-endpoint`
 *                target or endpoint).
 *
 * All fields are optional; an empty `EnvInjection` is a valid no-op
 * (the installer will treat it as "this listener took no action").
 */
export interface EnvInjection {
  readonly env?: Readonly<
    Record<string, EnvValue>
  >;
  readonly mounts?: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly target?: OutputMaterial;
}

export type SecretEnvRef = Readonly<{ secretRef: string }>;

export type EnvValue = string | SecretEnvRef;

export type ResolvedEnv = Readonly<Record<string, EnvValue>>;

export interface ResolvedInputBinding {
  readonly listenerComponent: string;
  readonly bindingName: BindingName;
  readonly sourceRef: ListenSourceRef;
  readonly options: BindingOptions;
  readonly envInjections: Readonly<
    Record<string, EnvValue>
  >;
  readonly mounts?: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly target?: OutputMaterial;
  /** The raw material payload resolved from the source reference. */
  readonly material: OutputMaterial;
}

/**
 * @deprecated Renamed to {@link ResolvedInputBinding}. Remove once no consumer
 * operator implementation imports `ResolvedListenBinding`.
 */
export type ResolvedListenBinding = ResolvedInputBinding;

export interface OperatorImplementationApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  /** Source summary for this Deployment, including prepared source digest when available. */
  readonly source: SourceSummary;
  /** Local directory containing the already-prepared source snapshot. */
  readonly sourceDirectory: string;
  /**
   * Materials this component consumes, keyed by the local binding name as
   * declared by the reference implementation wiring. Pre-resolved by the
   * installer from reference component outputs or Space-visible platform
   * services; the consuming component's
   * `applyBinding` has
   * already been invoked and the resulting env / mount / target
   * descriptors are merged into the runtime environment.
   *
   * This map is for implementations that need access to the raw material payload
   * (e.g. to inspect specific fields beyond what `applyBinding` emitted).
   */
  readonly inputMaterials?: Readonly<
    Record<BindingName, OutputMaterial>
  >;
  /**
   * @deprecated Renamed to `inputMaterials`. The installer still populates this
   * field with the same map, so it is required for now. Make it optional and
   * then remove once no service binding code or operator implementation reads
   * `ctx.listenedMaterials`.
   */
  readonly listenedMaterials: Readonly<
    Record<BindingName, OutputMaterial>
  >;
  /**
   * Env / mount / target descriptors produced by `applyBinding` for each input
   * edge. Native OperatorImplementation implementations should use this field
   * when they need the actual runtime injection plan instead of raw materials.
   */
  readonly resolvedBindings: readonly ResolvedInputBinding[];
}

export interface OperatorImplementationApplyResult {
  /**
   * Backend-side resource handle. The service treats it as opaque
   * implementation evidence and passes it back to `destroy()` when needed.
   */
  readonly resourceHandle: string;
  /**
   * Outputs persisted on Deployment evidence and surfaced to the material
   * registry via subsequent `materializeOutput()` calls. Implementations may return any
   * JSON-valued map; the keys typically match the kind descriptor's
   * `outputs[].name`.
   */
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

export interface OutputMaterialContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  /** Component output slot this material is projected from. */
  readonly outputName: OutputSlotName;
  /** Publication options when this material serves an Installation output declaration. */
  readonly options?: PublishOptions;
  /** Outputs from the preceding `apply()` call for this component. */
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

export interface ApplyInputBindingContext {
  readonly installationId: string;
  /** Name of the consuming component. */
  readonly componentName: string;
  readonly component: Component;
  /** Local binding name being resolved. */
  readonly bindingName: BindingName;
  /** Source component output ref or platform service path being consumed. */
  readonly sourceRef: ListenSourceRef;
  /** Per-binding options from reference implementation wiring. */
  readonly options: BindingOptions;
  /** Material payload resolved from the source reference. */
  readonly material: OutputMaterial;
}

/**
 * @deprecated Renamed to {@link ApplyInputBindingContext}. Remove once no
 * consumer imports `ApplyListenContext`.
 */
export type ApplyListenContext = ApplyInputBindingContext;

export interface OperatorImplementationDestroyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly resourceHandle: string;
}

export interface OperatorImplementationStatusContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly resourceHandle: string;
}

export type OperatorImplementationResourceStatusKind =
  | "pending"
  | "ready"
  | "degraded"
  | "failed"
  | "deleted";

export interface OperatorImplementationResourceStatus {
  readonly kind: OperatorImplementationResourceStatusKind;
  readonly outputs?: Readonly<Record<string, JsonValue>>;
  readonly reason?: string;
  readonly observedAt: string;
}

export interface OperatorImplementationInstallationContext {
  readonly installation: Installation;
  readonly deployment?: Deployment;
}

export interface OperatorImplementationDeploymentContext {
  readonly installation: Installation;
  readonly deployment: Deployment;
}

export type NativeResourceHandle = string;

export interface NativeKindApplyDiagnostic {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: JsonObject;
}

export interface NativeKindApplyResult<Outputs = JsonObject> {
  readonly handle: NativeResourceHandle;
  readonly outputs: Outputs;
  readonly diagnostics?: readonly NativeKindApplyDiagnostic[];
}

export type NativeKindResourceStatusKind = OperatorImplementationResourceStatusKind;

export interface NativeKindSpecValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface NativeKindResourceStatus<Outputs = JsonObject> {
  readonly kind: NativeKindResourceStatusKind;
  readonly outputs?: Outputs;
  readonly reason?: string;
  readonly observedAt: string;
}

export type NativeKindOutputMaterialContext<Outputs = JsonObject> =
  & Omit<
    OutputMaterialContext,
    "outputs"
  >
  & {
    readonly outputs: Outputs;
  };

/**
 * Operations for a native kind implementation that wants the reference implementation binding shape
 * without using the retired shape/provider compatibility API.
 */
export interface NativeKindOperations<Spec = JsonObject, Outputs = JsonObject> {
  readonly id: string;
  readonly version: string;
  readonly capabilities?: readonly string[];
  validateSpec?(
    value: unknown,
  ): readonly NativeKindSpecValidationIssue[];
  validateComponent?(component: Component): void | Promise<void>;
  /**
   * Receives the reference component spec unchanged. Runtime inputs
   * derived from selected bindings live on `ctx.resolvedBindings`; implementations that
   * need env-style injection can opt in with {@link mergeResolvedEnv}.
   */
  apply(
    spec: Spec,
    ctx: OperatorImplementationApplyContext,
  ): Promise<NativeKindApplyResult<Outputs>>;
  destroy?(
    handle: NativeResourceHandle,
    ctx: OperatorImplementationDestroyContext,
  ): Promise<void>;
  status?(
    handle: NativeResourceHandle,
    ctx: OperatorImplementationStatusContext,
  ): Promise<NativeKindResourceStatus<Outputs>>;
  materializeOutput?(
    ctx: NativeKindOutputMaterialContext<Outputs>,
  ): Promise<OutputMaterial> | OutputMaterial;
  /**
   * @deprecated Renamed to `materializeOutput`;
   * `operatorImplementationFromNativeKindOperations` reads
   * `materializeOutput ?? publishMaterial`. Remove once the cloudflare D1 /
   * KV / queue / vectorize provider implementations define
   * `materializeOutput` instead of `publishMaterial`.
   */
  publishMaterial?(
    ctx: NativeKindOutputMaterialContext<Outputs>,
  ): Promise<OutputMaterial> | OutputMaterial;
}

/**
 * Build a reference `OperatorImplementation` from native kind operations. This is the
 * current helper for native kind implementations: the implementation
 * owns backend-specific operations, while the reference service still receives a
 * Vite-style plain-array `OperatorImplementation`.
 */
export function operatorImplementationFromNativeKindOperations<Spec, Outputs>(
  opts: {
    readonly operations: NativeKindOperations<Spec, Outputs>;
    readonly kindUri: string;
    readonly name?: string;
    readonly version?: string;
    readonly capabilities?: readonly string[];
  },
): OperatorImplementation {
  const operations = opts.operations;
  const capabilities = opts.capabilities ?? operations.capabilities;
  const materializeOutput = async (
    ctx: OutputMaterialContext,
  ): Promise<OutputMaterial> => {
    const materialKind = ctx.options?.kind;
    const operation = operations.materializeOutput ??
      operations.publishMaterial;
    if (operation) {
      return validatePublishedOutputMaterial(
        materialKind,
        await operation({
          ...ctx,
          outputs: ctx.outputs as Outputs,
        }),
      );
    }
    return outputsToOutputMaterial(ctx.outputs, materialKind);
  };
  return {
    name: opts.name ?? operations.id,
    version: opts.version ?? operations.version,
    provides: [opts.kindUri],
    ...(capabilities ? { capabilities } : {}),
    validateComponent(component) {
      const spec = (component.spec ?? {}) as Spec;
      const issues = operations.validateSpec?.(spec) ?? [];
      if (issues.length > 0) {
        throw new Error(
          `component spec invalid for ${opts.kindUri}: ${
            issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
          }`,
        );
      }
      return operations.validateComponent?.(component);
    },
    async apply(ctx) {
      const spec = (ctx.component.spec ?? {}) as Spec;
      const issues = operations.validateSpec?.(spec) ?? [];
      if (issues.length > 0) {
        throw new Error(
          `component ${ctx.componentName} spec invalid for ${opts.kindUri}: ${
            issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
          }`,
        );
      }
      const result = await operations.apply(spec, ctx);
      return {
        resourceHandle: result.handle,
        outputs: (result.outputs ?? {}) as Readonly<Record<string, JsonValue>>,
      };
    },
    materializeOutput,
    async destroy(ctx) {
      await operations.destroy?.(ctx.resourceHandle, ctx);
    },
    ...(operations.status
      ? {
        async status(ctx) {
          const result = await operations.status!(ctx.resourceHandle, ctx);
          return {
            kind: result.kind,
            ...(result.outputs
              ? {
                outputs: result.outputs as Readonly<Record<string, JsonValue>>,
              }
              : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            observedAt: result.observedAt,
          };
        },
      }
      : {}),
  };
}

function validatePublishedOutputMaterial(
  contract: string | undefined,
  material: OutputMaterial,
): OutputMaterial {
  if (contract === undefined || !isOfficialMaterialKindName(contract)) {
    return material;
  }
  const issues = validateOfficialMaterial(contract, material);
  if (issues.length > 0) {
    throw new Error(
      `implementation produced invalid ${contract} output material: ${
        issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
      }`,
    );
  }
  return material;
}

export function outputsToOutputMaterial(
  outputs: Readonly<Record<string, JsonValue>>,
  contract?: string,
): OutputMaterial {
  const generic = rawOutputsToOutputMaterial(outputs);
  if (contract === undefined || !isOfficialMaterialKindName(contract)) {
    return generic;
  }
  const material = projectOfficialMaterial(contract, generic);
  const issues = validateOfficialMaterial(contract, material);
  if (issues.length > 0) {
    throw new Error(
      `implementation outputs cannot be projected to ${contract} material: ${
        issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
      }`,
    );
  }
  return material;
}

function rawOutputsToOutputMaterial(
  outputs: Readonly<Record<string, JsonValue>>,
): OutputMaterial {
  const material: Record<string, JsonValue | { secretRef: string }> = {};
  for (const [key, value] of Object.entries(outputs)) {
    material[key] = secretRefMaterial(key, value) ?? value;
  }
  return material;
}

function projectOfficialMaterial(
  contract: string,
  material: OutputMaterial,
): OutputMaterial {
  switch (contract) {
    case "http-endpoint":
      return projectHttpEndpointMaterial(material);
    case "service-binding":
      return projectServiceBindingMaterial(material);
    case "object-store":
      return projectObjectStoreMaterial(material);
    default:
      return material;
  }
}

function projectHttpEndpointMaterial(
  material: OutputMaterial,
): OutputMaterial {
  if (Array.isArray(material.targets) || Array.isArray(material.endpoints)) {
    return material;
  }
  const url = readString(material.url);
  const host = readString(material.host) ?? readString(material.internalHost);
  const port = readNumber(material.port) ?? readNumber(material.internalPort);
  const listener = readString(material.listener);
  const scheme = readString(material.scheme);
  const routes = readRouteSummaries(material.routes);
  if (listener || scheme || routes) {
    if (!url) return material;
    const endpoint: Record<string, JsonValue> = {
      url,
      visibility: "public",
      primary: true,
    };
    if (scheme) endpoint.scheme = scheme;
    if (host) endpoint.host = host;
    if (listener) endpoint.listener = listener;
    if (routes) endpoint.routes = routes;
    return { endpoints: [endpoint] };
  }
  if (!url && !(host && port !== undefined)) return material;
  const target: Record<string, JsonValue> = {
    name: "default",
    visibility: "private",
  };
  if (url) target.url = url;
  if (host) target.host = host;
  if (port !== undefined) target.port = port;
  const protocol = readString(material.protocol);
  if (protocol) target.protocol = protocol;
  const basePath = readString(material.basePath);
  if (basePath) target.basePath = basePath;
  return { targets: [target] };
}

function projectServiceBindingMaterial(
  material: OutputMaterial,
): OutputMaterial {
  if (
    readString(material.protocol) &&
    readString(material.host) &&
    readNumber(material.port) !== undefined &&
    material.passwordSecretRef === undefined &&
    material.connectionString === undefined
  ) {
    return material;
  }
  const host = readString(material.host);
  const port = readNumber(material.port);
  if (!host || port === undefined) return material;
  const out: Record<string, JsonValue | { secretRef: string }> = {
    protocol: readString(material.protocol) ?? inferServiceProtocol(material),
    host,
    port,
  };
  const service = readString(material.service) ?? host;
  if (service) out.service = service;
  const database = readString(material.database);
  if (database) out.database = database;
  const username = readString(material.username);
  if (username) out.username = username;
  const connectionUrl = readString(material.connectionUrl) ??
    readString(material.connectionString);
  if (connectionUrl) out.connectionUrl = connectionUrl;
  const caCertRef = readString(material.caCertRef);
  if (caCertRef) out.caCertRef = caCertRef;
  const passwordRef = readSecretReference(material.passwordRef) ??
    readSecretReference(material.passwordSecretRef);
  if (passwordRef) out.passwordRef = passwordRef;
  const tokenRef = readSecretReference(material.tokenRef);
  if (tokenRef) out.tokenRef = tokenRef;
  if (isRecord(material.tokenRefs)) out.tokenRefs = material.tokenRefs;
  return out;
}

function projectObjectStoreMaterial(
  material: OutputMaterial,
): OutputMaterial {
  const bucket = readString(material.bucket);
  const endpoint = readString(material.endpoint);
  if (!bucket || !endpoint) return material;
  if (
    material.accessKeyRef !== undefined || material.secretKeyRef !== undefined
  ) {
    return material;
  }
  const out: Record<string, JsonValue | { secretRef: string }> = {
    bucket,
    endpoint,
  };
  const region = readString(material.region);
  if (region) out.region = region;
  if (typeof material.pathStyle === "boolean") {
    out.pathStyle = material.pathStyle;
  }
  const publicBaseUrl = readString(material.publicBaseUrl);
  if (publicBaseUrl) out.publicBaseUrl = publicBaseUrl;
  if (Array.isArray(material.policyRefs)) out.policyRefs = material.policyRefs;
  const accessKeyIdRef = readSecretReference(material.accessKeyIdRef);
  if (accessKeyIdRef) out.accessKeyIdRef = accessKeyIdRef;
  const secretAccessKeyRef = readSecretReference(material.secretAccessKeyRef);
  if (secretAccessKeyRef) out.secretAccessKeyRef = secretAccessKeyRef;
  const sessionTokenRef = readSecretReference(material.sessionTokenRef);
  if (sessionTokenRef) out.sessionTokenRef = sessionTokenRef;
  return out;
}

function inferServiceProtocol(material: OutputMaterial): string {
  const connection = readString(material.connectionString) ??
    readString(material.connectionUrl);
  if (connection?.startsWith("postgres://")) return "postgresql";
  if (connection?.startsWith("postgresql://")) return "postgresql";
  if (
    material.database !== undefined || material.passwordSecretRef !== undefined
  ) {
    return "postgresql";
  }
  return "tcp";
}

function readRouteSummaries(
  value: OutputMaterial[string],
): JsonValue | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    if (!isRecord(entry)) return {};
    const pathPrefix = readString(entry.pathPrefix);
    const to = readString(entry.to);
    return {
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(to ? { to } : {}),
    };
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readSecretReference(
  value: unknown,
): { readonly secretRef: string } | undefined {
  if (isRecord(value) && readString(value.secretRef)) {
    return { secretRef: value.secretRef as string };
  }
  if (typeof value === "string" && value.startsWith("secret://")) {
    return { secretRef: value };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function secretRefMaterial(
  key: string,
  value: JsonValue,
): { secretRef: string } | undefined {
  if (
    typeof value === "string" &&
    key.endsWith("Ref") &&
    value.startsWith("secret://")
  ) {
    return { secretRef: value };
  }
  return undefined;
}

/**
 * Merge explicit `spec.env` values with env descriptors produced by input
 * binding resolution. Native implementations call this intentionally when
 * their runtime accepts env variables; the generic OperatorImplementation wrapper does
 * not mutate `component.spec`.
 */
export function mergeResolvedEnv(
  explicitEnv: Readonly<Record<string, string>> | undefined,
  bindings: readonly ResolvedInputBinding[],
): ResolvedEnv | undefined {
  const env = collectEnvBindings(bindings);
  if (Object.keys(env).length === 0) {
    return explicitEnv;
  }
  return mergeWithoutConflict(explicitEnv ?? {}, env, "$.env");
}

function collectEnvBindings(
  bindings: readonly ResolvedInputBinding[],
): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const binding of bindings) {
    for (const [key, value] of Object.entries(binding.envInjections)) {
      if (out[key] !== undefined && !sameEnvValue(out[key], value)) {
        throw new Error(
          `binding-derived env ${key} is defined more than once`,
        );
      }
      out[key] = value;
    }
  }
  return out;
}

function mergeWithoutConflict(
  explicit: Record<string, string>,
  injected: Record<string, EnvValue>,
  path: string,
): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = { ...explicit };
  for (const [key, value] of Object.entries(injected)) {
    const existing = out[key];
    if (existing !== undefined && !sameEnvValue(existing, value)) {
      throw new Error(
        `binding-derived ${path}.${key} conflicts with explicit spec`,
      );
    }
    out[key] = value;
  }
  return out;
}

function sameEnvValue(a: EnvValue, b: EnvValue): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.secretRef === b.secretRef;
}
