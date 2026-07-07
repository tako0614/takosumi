/**
 * Capsule output projection (deploy decision D3).
 *
 * A pure, store-free mapping from a Capsule's well-known OpenTofu Outputs
 * (`service_exports` / `service_bindings` arrays and the `app_deployment`
 * publish/consume convenience output) to TRANSIENT projected objects. There are
 * no DB writes, ledger rows, capability grants, or runtime authority here: this
 * module only reads output values and shapes them so a host (e.g. the Takos
 * product) can render or wire workload services from deployment Outputs.
 *
 * Output projection is NOT one of the OSS nouns; it is read-only state derived
 * from Output and deliberately does not recreate a service ledger.
 */

import type { JsonObject, JsonValue } from "../../../contract/types.ts";

/**
 * Well-known capability tokens a Capsule may project through `service_exports`
 * outputs. The list is descriptive (helps a host classify a projected service);
 * extension capabilities are allowed when `allowExtensionCapabilities` is set.
 */
export const STANDARD_PROJECTED_CAPABILITIES = [
  "protocol.mcp.server",
  "protocol.http.api",
  "protocol.grpc.api",
  "protocol.websocket.api",
  "interface.ui.surface",
  "interface.file.handler",
  "storage.object",
  "storage.filesystem",
  "storage.key_value",
  "storage.sql",
  "storage.vector",
  "storage.search_index",
  "source.repository",
  "source.git.smart_http",
  "compute.job_runner",
  "compute.sandbox",
  "automation.agent_runtime",
  "automation.tool_provider",
  "ai.model",
  "ai.embedding_model",
  "identity.oidc",
  "identity.oauth.client",
  "auth.bootstrap_token",
  "auth.token_exchange",
  "auth.webhook_signing",
  "messaging.queue",
  "messaging.pubsub",
  "events.webhook",
  "events.subscription",
  "observability.logs",
  "observability.metrics",
  "observability.traces",
  "billing.usage",
  "deployment.outputs",
  "control.api",
  "governance.policy",
  "governance.approval",
] as const;

export type StandardProjectedCapability =
  (typeof STANDARD_PROJECTED_CAPABILITIES)[number];

export type ProjectedCapability =
  StandardProjectedCapability | `${string}.${string}`;

export type ProjectedExportVisibility =
  "private" | "space" | "public" | "shared";

export type ProjectedBindingDependencyMode =
  "variable_injection" | "remote_state" | "published_output";

export type ProjectedBindingTargetKind =
  "generated_root" | "workload" | "runtime";

export interface ProjectedEndpoint {
  readonly name?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly host?: string;
  readonly port?: number;
  readonly pathPrefix?: string;
}

export interface ProjectedAuth {
  readonly scheme: "none" | "bearer" | "oidc" | "signed_webhook";
  readonly audience?: readonly string[];
  readonly scopes?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ProjectedServiceExport {
  readonly name: string;
  readonly capabilities: readonly ProjectedCapability[];
  readonly visibility: ProjectedExportVisibility;
  readonly endpoints?: readonly ProjectedEndpoint[];
  readonly auth?: readonly ProjectedAuth[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: JsonObject;
}

export interface ProjectedBindingSelector {
  readonly capabilities: readonly ProjectedCapability[];
  readonly producerCapsuleId?: string;
  readonly serviceExportId?: string;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ProjectedBindingTarget {
  readonly kind: ProjectedBindingTargetKind;
  readonly name?: string;
  readonly metadata?: JsonObject;
}

export interface ProjectedGrantRequest {
  readonly scopes: readonly string[];
  readonly audience?: readonly string[];
  readonly env?: readonly string[];
  readonly ttlSeconds?: number;
  readonly metadata?: JsonObject;
}

export interface ProjectedServiceBinding {
  readonly name: string;
  readonly target: ProjectedBindingTarget;
  readonly selector: ProjectedBindingSelector;
  readonly dependencyMode: ProjectedBindingDependencyMode;
  readonly grantRequest: ProjectedGrantRequest;
}

export interface ProjectServicesResult {
  readonly serviceExports: readonly ProjectedServiceExport[];
  readonly serviceBindings: readonly ProjectedServiceBinding[];
}

export interface ProjectServicesOptions {
  readonly allowExtensionCapabilities?: boolean;
  /**
   * When a `service_bindings[].selector.producer` is `"self"` (or a
   * `app_deployment.compute.*.consume` references the launcher), resolve the
   * producer to this Capsule id. Optional: when omitted, a self-producer
   * selector simply carries no `producerCapsuleId`.
   */
  readonly producerCapsuleId?: string;
}

type NormalizedProjectedExport = Omit<ProjectedServiceExport, never>;

type NormalizedProjectedBinding = Omit<ProjectedServiceBinding, "selector"> & {
  readonly selector: ProjectedBindingSelector;
  readonly selectorProducerIsSelf?: boolean;
};

const STANDARD_CAPABILITY_SET: ReadonlySet<string> = new Set(
  STANDARD_PROJECTED_CAPABILITIES,
);

const VISIBILITIES: readonly ProjectedExportVisibility[] = [
  "private",
  "space",
  "public",
  "shared",
];

const DEPENDENCY_MODES: readonly ProjectedBindingDependencyMode[] = [
  "variable_injection",
  "remote_state",
  "published_output",
];

const TARGET_KINDS: readonly ProjectedBindingTargetKind[] = [
  "generated_root",
  "workload",
  "runtime",
];

export function isStandardProjectedCapability(
  value: string,
): value is StandardProjectedCapability {
  return STANDARD_CAPABILITY_SET.has(value);
}

export function isProjectedCapability(
  value: string,
): value is ProjectedCapability {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value);
}

function isProjectedExportVisibility(
  value: unknown,
): value is ProjectedExportVisibility {
  return typeof value === "string" && VISIBILITIES.includes(value as never);
}

function isProjectedBindingDependencyMode(
  value: unknown,
): value is ProjectedBindingDependencyMode {
  return typeof value === "string" && DEPENDENCY_MODES.includes(value as never);
}

function isProjectedBindingTargetKind(
  value: unknown,
): value is ProjectedBindingTargetKind {
  return typeof value === "string" && TARGET_KINDS.includes(value as never);
}

/**
 * Maps a Capsule's well-known Outputs to transient projected service exports +
 * bindings. Pure: no stores, ledger rows, or runtime authority.
 */
export function projectServicesFromOutputs(
  outputs: Readonly<Record<string, JsonValue>>,
  options: ProjectServicesOptions = {},
): ProjectServicesResult {
  const allow = options.allowExtensionCapabilities === true;
  const serviceExports = normalizeProjectedExports(outputs, allow).map(
    (normalized) => ({ ...normalized }),
  );
  const serviceBindings = normalizeProjectedBindings(outputs, allow).map(
    (normalized) => {
      const { selectorProducerIsSelf, ...binding } = normalized;
      const selector =
        selectorProducerIsSelf && options.producerCapsuleId
          ? {
              ...normalized.selector,
              producerCapsuleId: options.producerCapsuleId,
            }
          : normalized.selector;
      return { ...binding, selector };
    },
  );
  return { serviceExports, serviceBindings };
}

/**
 * Validates that a Capsule's `service_exports` / `service_bindings` / `app_deployment`
 * outputs are well-formed (throws a `TypeError` on a malformed output). Used at
 * apply time to fail closed on a Capsule that emits a bad output shape.
 */
export function validateProjectedServiceExportsFromOutputSnapshot(
  outputs: Readonly<Record<string, JsonValue>>,
  options: { readonly allowExtensionCapabilities?: boolean } = {},
): void {
  const allow = options.allowExtensionCapabilities === true;
  normalizeProjectedExports(outputs, allow);
  normalizeProjectedBindings(outputs, allow);
}

function normalizeProjectedExports(
  outputs: Readonly<Record<string, JsonValue>>,
  allowExtensionCapabilities: boolean,
): readonly NormalizedProjectedExport[] {
  const projected: NormalizedProjectedExport[] = [];
  const rawExports = outputs.service_exports;
  if (rawExports !== undefined) {
    if (!Array.isArray(rawExports)) {
      throw new TypeError("service_exports output must be an array");
    }
    for (const [index, value] of rawExports.entries()) {
      const normalized = normalizeProjectedExport(value, index);
      assertCapabilitiesAllowed(
        normalized.capabilities,
        allowExtensionCapabilities,
        `service_exports[${index}].capabilities`,
      );
      projected.push(normalized);
    }
  }

  const appDeploymentExports = normalizeAppDeploymentPublishExports(
    outputs.app_deployment,
  );
  for (const [index, normalized] of appDeploymentExports.entries()) {
    assertCapabilitiesAllowed(
      normalized.capabilities,
      allowExtensionCapabilities,
      `app_deployment.publish[${index}].capabilities`,
    );
    projected.push(normalized);
  }

  return projected;
}

function normalizeProjectedBindings(
  outputs: Readonly<Record<string, JsonValue>>,
  allowExtensionCapabilities: boolean,
): readonly NormalizedProjectedBinding[] {
  const projected: NormalizedProjectedBinding[] = [];
  const rawBindings = outputs.service_bindings;
  if (rawBindings !== undefined) {
    if (!Array.isArray(rawBindings)) {
      throw new TypeError("service_bindings output must be an array");
    }
    for (const [index, value] of rawBindings.entries()) {
      projected.push(normalizeProjectedBinding(value, index));
    }
  }

  projected.push(
    ...normalizeAppDeploymentConsumeBindings(outputs.app_deployment),
  );
  for (const [index, normalized] of projected.entries()) {
    assertCapabilitiesAllowed(
      normalized.selector.capabilities,
      allowExtensionCapabilities,
      `projected service binding[${index}].selector.capabilities`,
    );
  }
  return projected;
}

function assertCapabilitiesAllowed(
  capabilities: readonly ProjectedCapability[],
  allowExtensionCapabilities: boolean,
  field: string,
): void {
  if (allowExtensionCapabilities) return;
  for (const [index, capability] of capabilities.entries()) {
    if (!isStandardProjectedCapability(capability)) {
      throw new TypeError(
        `${field}[${index}] must be a standard projected capability unless extension capabilities are explicitly enabled`,
      );
    }
  }
}

function normalizeProjectedExport(
  value: JsonValue,
  index: number,
): NormalizedProjectedExport {
  if (!isJsonObject(value)) {
    throw new TypeError(`service_exports[${index}] must be an object`);
  }
  const name = stringField(value, "name", index);
  const capabilities = capabilityArrayField(value, "capabilities", index);
  const visibilityRaw = optionalStringField(value, "visibility", index);
  const visibility = visibilityRaw ?? "space";
  if (!isProjectedExportVisibility(visibility)) {
    throw new TypeError(
      `service_exports[${index}].visibility must be private, space, public, or shared`,
    );
  }
  return {
    name,
    capabilities,
    visibility,
    endpoints: optionalEndpointArrayField(value, "endpoints", index),
    auth: optionalAuthArrayField(value, "auth", index),
    labels: optionalStringRecordField(value, "labels", index),
    metadata: optionalJsonObjectField(value, "metadata", index),
  };
}

function normalizeProjectedBinding(
  value: JsonValue,
  index: number,
): NormalizedProjectedBinding {
  if (!isJsonObject(value)) {
    throw new TypeError(`service_bindings[${index}] must be an object`);
  }
  const stableName = stringFieldFor("service_bindings", value, "name", index);
  const selectorResult = normalizeProjectedBindingSelector(
    value.selector,
    index,
  );
  return {
    name: stableName,
    target: normalizeProjectedBindingTarget(value.target, index),
    selector: selectorResult.selector,
    selectorProducerIsSelf: selectorResult.producerIsSelf,
    dependencyMode:
      optionalDependencyModeField(value, index) ?? "variable_injection",
    grantRequest: normalizeProjectedGrantRequest(
      value.grant_request ?? value.grantRequest,
      index,
    ),
  };
}

function normalizeProjectedBindingTarget(
  value: JsonValue | undefined,
  index: number,
): ProjectedBindingTarget {
  if (!isJsonObject(value)) {
    throw new TypeError(`service_bindings[${index}].target must be an object`);
  }
  const kind = stringFieldFor(
    "service_bindings",
    value,
    "kind",
    index,
    ".target",
  );
  if (!isProjectedBindingTargetKind(kind)) {
    throw new TypeError(
      `service_bindings[${index}].target.kind must be generated_root, workload, or runtime`,
    );
  }
  return {
    kind,
    name: optionalStringFor(
      "service_bindings",
      value,
      "name",
      index,
      ".target",
    ),
    metadata: optionalJsonObjectFieldFor(
      "service_bindings",
      value,
      "metadata",
      index,
      ".target",
    ),
  };
}

function normalizeProjectedBindingSelector(
  value: JsonValue | undefined,
  index: number,
): {
  readonly selector: ProjectedBindingSelector;
  readonly producerIsSelf?: boolean;
} {
  if (!isJsonObject(value)) {
    throw new TypeError(
      `service_bindings[${index}].selector must be an object`,
    );
  }
  const capabilities = capabilityArrayFieldFor(
    "service_bindings",
    value,
    "capabilities",
    index,
    ".selector",
  );
  const producerRaw =
    value.producer ?? value.producer_capsule_id ?? value.producerCapsuleId;
  const producer =
    producerRaw === undefined
      ? undefined
      : requiredString(
          producerRaw,
          `service_bindings[${index}].selector.producer`,
        );
  const producerIsSelf = producer === "self";
  return {
    selector: {
      capabilities,
      name: optionalStringFor(
        "service_bindings",
        value,
        "name",
        index,
        ".selector",
      ),
      serviceExportId:
        optionalStringFor(
          "service_bindings",
          value,
          "service_export_id",
          index,
          ".selector",
        ) ??
        optionalStringFor(
          "service_bindings",
          value,
          "serviceExportId",
          index,
          ".selector",
        ),
      producerCapsuleId: producerIsSelf ? undefined : producer,
      labels: optionalStringRecordFieldFor(
        "service_bindings",
        value,
        "labels",
        index,
        ".selector",
      ),
    },
    producerIsSelf: producerIsSelf || undefined,
  };
}

function optionalDependencyModeField(
  value: JsonObject,
  index: number,
): ProjectedBindingDependencyMode | undefined {
  const raw = value.dependency_mode ?? value.dependencyMode;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !isProjectedBindingDependencyMode(raw)) {
    throw new TypeError(
      `service_bindings[${index}].dependency_mode must be variable_injection, remote_state, or published_output`,
    );
  }
  return raw;
}

function normalizeProjectedGrantRequest(
  value: JsonValue | undefined,
  index: number,
): ProjectedGrantRequest {
  if (!isJsonObject(value)) {
    throw new TypeError(
      `service_bindings[${index}].grant_request must be an object`,
    );
  }
  const ttlRaw = value.ttl_seconds ?? value.ttlSeconds;
  const ttlSeconds =
    ttlRaw === undefined ? undefined : numericTtlSeconds(ttlRaw, index);
  return {
    scopes:
      optionalStringArrayFieldFor(
        "service_bindings",
        value,
        "scopes",
        index,
        ".grant_request",
      ) ?? [],
    audience: optionalStringArrayFieldFor(
      "service_bindings",
      value,
      "audience",
      index,
      ".grant_request",
    ),
    env: optionalStringArrayFieldFor(
      "service_bindings",
      value,
      "env",
      index,
      ".grant_request",
    ),
    ttlSeconds,
    metadata: optionalJsonObjectFieldFor(
      "service_bindings",
      value,
      "metadata",
      index,
      ".grant_request",
    ),
  };
}

function normalizeAppDeploymentPublishExports(
  value: JsonValue | undefined,
): readonly NormalizedProjectedExport[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) {
    throw new TypeError("app_deployment output must be an object when present");
  }
  const publish = value.publish;
  if (publish === undefined) return [];
  if (!Array.isArray(publish)) {
    throw new TypeError("app_deployment.publish must be an array when present");
  }
  const appName = optionalString(value.name, "app_deployment.name");
  const appVersion = optionalString(value.version, "app_deployment.version");
  return publish.map((entry, index) => {
    if (!isJsonObject(entry)) {
      throw new TypeError(`app_deployment.publish[${index}] must be an object`);
    }
    const name = requiredString(
      entry.name,
      `app_deployment.publish[${index}].name`,
    );
    const type = requiredString(
      entry.type,
      `app_deployment.publish[${index}].type`,
    );
    const capability = capabilityFromAppDeploymentPublicationType(
      type,
      `app_deployment.publish[${index}].type`,
    );
    const visibilityRaw = optionalString(
      entry.visibility,
      `app_deployment.publish[${index}].visibility`,
    );
    const visibility = visibilityRaw ?? "space";
    if (!isProjectedExportVisibility(visibility)) {
      throw new TypeError(
        `app_deployment.publish[${index}].visibility must be private, space, public, or shared`,
      );
    }
    const publisher = optionalString(
      entry.publisher,
      `app_deployment.publish[${index}].publisher`,
    );
    return {
      name,
      capabilities: [capability],
      visibility,
      endpoints: endpointsFromAppDeploymentPublishOutputs(entry.outputs),
      labels: compactStringRecord({
        app: appName,
        version: appVersion,
        publisher,
      }),
      metadata: compactJsonObject({
        source: "app_deployment.publish",
        appName,
        appVersion,
        publisher,
        type,
        outputs: optionalJsonObject(entry.outputs),
        display: optionalJsonObject(entry.display),
        spec: optionalJsonObject(entry.spec),
      }),
    };
  });
}

function normalizeAppDeploymentConsumeBindings(
  value: JsonValue | undefined,
): readonly NormalizedProjectedBinding[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) {
    throw new TypeError("app_deployment output must be an object when present");
  }
  const compute = value.compute;
  if (compute === undefined) return [];
  if (!isJsonObject(compute)) {
    throw new TypeError(
      "app_deployment.compute must be an object when present",
    );
  }
  const appName = optionalString(value.name, "app_deployment.name");
  const bindings: NormalizedProjectedBinding[] = [];
  for (const [componentName, componentValue] of Object.entries(compute)) {
    if (!isJsonObject(componentValue)) {
      throw new TypeError(
        `app_deployment.compute.${componentName} must be an object`,
      );
    }
    const consume = componentValue.consume;
    if (consume === undefined) continue;
    if (!Array.isArray(consume)) {
      throw new TypeError(
        `app_deployment.compute.${componentName}.consume must be an array when present`,
      );
    }
    for (const [index, entry] of consume.entries()) {
      if (!isJsonObject(entry)) {
        throw new TypeError(
          `app_deployment.compute.${componentName}.consume[${index}] must be an object`,
        );
      }
      const publication = requiredString(
        entry.publication,
        `app_deployment.compute.${componentName}.consume[${index}].publication`,
      );
      const capability = capabilityFromAppDeploymentConsume(
        entry,
        publication,
        `app_deployment.compute.${componentName}.consume[${index}]`,
      );
      const env = envNamesFromAppDeploymentInject(entry.inject);
      bindings.push({
        name: `${componentName}_${publication}`,
        target: {
          kind: "workload",
          name: componentName,
          metadata: compactJsonObject({
            source: "app_deployment.compute",
            appName,
            componentName,
            componentKind: optionalString(
              componentValue.kind,
              `app_deployment.compute.${componentName}.kind`,
            ),
          }),
        },
        selector: {
          capabilities: [capability],
          name: publication,
        },
        selectorProducerIsSelf: publication === "launcher" || undefined,
        dependencyMode: "variable_injection",
        grantRequest: {
          scopes: scopesFromAppDeploymentConsume(entry, capability),
          audience: [componentName],
          ...(env.length > 0 ? { env } : {}),
          metadata: compactJsonObject({
            source: "app_deployment.compute.consume",
            appName,
            componentName,
            publication,
            sourceRef:
              capability === "identity.oidc"
                ? "takosumi.identity.oidc"
                : undefined,
            inject: optionalJsonObject(entry.inject),
          }),
        },
      });
    }
  }
  return bindings;
}

function capabilityFromAppDeploymentPublicationType(
  value: string,
  field: string,
): ProjectedCapability {
  switch (value) {
    case "UiSurface":
    case "ui.surface":
    case "launcher":
      return "interface.ui.surface";
    case "McpServer":
    case "mcp.server":
      return "protocol.mcp.server";
    default:
      if (isProjectedCapability(value)) return value;
      throw new TypeError(
        `${field} must be a known app_deployment publication type or dotted projected capability`,
      );
  }
}

function capabilityFromAppDeploymentConsume(
  entry: JsonObject,
  publication: string,
  field: string,
): ProjectedCapability {
  const explicit = optionalString(entry.capability, `${field}.capability`);
  if (explicit !== undefined) {
    if (!isProjectedCapability(explicit)) {
      throw new TypeError(`${field}.capability must be a dotted capability`);
    }
    return explicit;
  }
  switch (publication) {
    case "identity.oidc":
      return "identity.oidc";
    case "launcher":
      return "interface.ui.surface";
    case "mcp":
    case "mcp.server":
      return "protocol.mcp.server";
    default:
      return isProjectedCapability(publication)
        ? publication
        : "deployment.outputs";
  }
}

function scopesFromAppDeploymentConsume(
  entry: JsonObject,
  capability: ProjectedCapability,
): readonly string[] {
  // Accept both the flat `consume[].scopes` and the nested
  // `consume[].request.scopes` shape (the latter is what takos-office uses).
  const raw =
    entry.scopes ??
    (isJsonObject(entry.request) ? entry.request.scopes : undefined);
  if (raw !== undefined) {
    if (
      !Array.isArray(raw) ||
      raw.some((scope) => typeof scope !== "string" || scope.length === 0)
    ) {
      throw new TypeError("app_deployment consume scopes must be string[]");
    }
    return [...new Set(raw as string[])];
  }
  if (capability === "identity.oidc") return ["openid", "profile", "email"];
  return [];
}

function envNamesFromAppDeploymentInject(
  value: JsonValue | undefined,
): readonly string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) {
    throw new TypeError("app_deployment consume inject must be an object");
  }
  const rawEnv = value.env;
  if (rawEnv === undefined) return [];
  if (!isJsonObject(rawEnv)) {
    throw new TypeError("app_deployment consume inject.env must be an object");
  }
  const names: string[] = [];
  for (const envName of Object.values(rawEnv)) {
    if (typeof envName !== "string" || envName.length === 0) {
      throw new TypeError(
        "app_deployment consume inject.env values must be env var names",
      );
    }
    names.push(envName);
  }
  return [...new Set(names)];
}

function endpointsFromAppDeploymentPublishOutputs(
  value: JsonValue | undefined,
): readonly ProjectedEndpoint[] | undefined {
  if (!isJsonObject(value)) return undefined;
  const endpoints: ProjectedEndpoint[] = [];
  for (const [name, output] of Object.entries(value)) {
    if (!isJsonObject(output)) continue;
    const kind = output.kind;
    const url = output.url ?? output.value;
    if (kind === "url" && typeof url === "string" && url.length > 0) {
      endpoints.push({ name, url });
    }
  }
  return endpoints.length > 0 ? endpoints : undefined;
}

function compactStringRecord(
  value: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactJsonObject(
  value: Readonly<Record<string, JsonValue | undefined>>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as JsonObject;
}

function optionalJsonObject(
  value: JsonValue | undefined,
): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  value: JsonValue | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string when present`);
  }
  return value;
}

function stringField(value: JsonObject, field: string, index: number): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(`service_exports[${index}].${field} is required`);
  }
  return item;
}

function stringFieldFor(
  outputName: string,
  value: JsonObject,
  field: string,
  index: number,
  prefix = "",
): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(
      `${outputName}[${index}]${prefix}.${field} is required`,
    );
  }
  return item;
}

function optionalStringFor(
  outputName: string,
  value: JsonObject,
  field: string,
  index: number,
  prefix = "",
): string | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(
      `${outputName}[${index}]${prefix}.${field} must be a non-empty string`,
    );
  }
  return item;
}

function optionalStringField(
  value: JsonObject,
  field: string,
  index: number,
): string | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(
      `service_exports[${index}].${field} must be a non-empty string`,
    );
  }
  return item;
}

function capabilityArrayField(
  value: JsonObject,
  field: string,
  index: number,
): readonly ProjectedCapability[] {
  const item = value[field];
  if (!Array.isArray(item) || item.length === 0) {
    throw new TypeError(
      `service_exports[${index}].${field} must contain at least one capability`,
    );
  }
  return item.map((capability, capabilityIndex) => {
    if (typeof capability !== "string" || !isProjectedCapability(capability)) {
      throw new TypeError(
        `service_exports[${index}].${field}[${capabilityIndex}] must be a dotted capability token`,
      );
    }
    return capability;
  });
}

function capabilityArrayFieldFor(
  outputName: string,
  value: JsonObject,
  field: string,
  index: number,
  prefix = "",
): readonly ProjectedCapability[] {
  const item = value[field];
  if (!Array.isArray(item) || item.length === 0) {
    throw new TypeError(
      `${outputName}[${index}]${prefix}.${field} must contain at least one capability`,
    );
  }
  return item.map((capability, capabilityIndex) => {
    if (typeof capability !== "string" || !isProjectedCapability(capability)) {
      throw new TypeError(
        `${outputName}[${index}]${prefix}.${field}[${capabilityIndex}] must be a dotted capability token`,
      );
    }
    return capability;
  });
}

function optionalEndpointArrayField(
  value: JsonObject,
  field: string,
  index: number,
): readonly ProjectedEndpoint[] | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!Array.isArray(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an array`);
  }
  return item.map((endpoint, endpointIndex) => {
    if (!isJsonObject(endpoint)) {
      throw new TypeError(
        `service_exports[${index}].${field}[${endpointIndex}] must be an object`,
      );
    }
    return endpoint as ProjectedEndpoint;
  });
}

function optionalAuthArrayField(
  value: JsonObject,
  field: string,
  index: number,
): readonly ProjectedAuth[] | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!Array.isArray(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an array`);
  }
  return item.map((auth, authIndex) => {
    if (!isJsonObject(auth)) {
      throw new TypeError(
        `service_exports[${index}].${field}[${authIndex}] must be an object`,
      );
    }
    return auth as unknown as ProjectedAuth;
  });
}

function optionalStringRecordField(
  value: JsonObject,
  field: string,
  index: number,
): Readonly<Record<string, string>> | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!isJsonObject(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an object`);
  }
  for (const [key, entry] of Object.entries(item)) {
    if (key.length === 0 || typeof entry !== "string") {
      throw new TypeError(
        `service_exports[${index}].${field} entries must be string:string`,
      );
    }
  }
  return item as Readonly<Record<string, string>>;
}

function optionalStringRecordFieldFor(
  outputName: string,
  value: JsonObject,
  field: string,
  index: number,
  prefix = "",
): Readonly<Record<string, string>> | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!isJsonObject(item)) {
    throw new TypeError(
      `${outputName}[${index}]${prefix}.${field} must be an object`,
    );
  }
  for (const [key, entry] of Object.entries(item)) {
    if (key.length === 0 || typeof entry !== "string") {
      throw new TypeError(
        `${outputName}[${index}]${prefix}.${field} entries must be string:string`,
      );
    }
  }
  return item as Readonly<Record<string, string>>;
}

function optionalJsonObjectField(
  value: JsonObject,
  field: string,
  index: number,
): JsonObject | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!isJsonObject(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an object`);
  }
  return item;
}

function optionalJsonObjectFieldFor(
  outputName: string,
  value: JsonObject,
  field: string,
  index: number,
  prefix = "",
): JsonObject | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!isJsonObject(item)) {
    throw new TypeError(
      `${outputName}[${index}]${prefix}.${field} must be an object`,
    );
  }
  return item;
}

function optionalStringArrayFieldFor(
  outputName: string,
  value: JsonObject,
  field: string,
  index: number,
  prefix = "",
): readonly string[] | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (
    !Array.isArray(item) ||
    item.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new TypeError(
      `${outputName}[${index}]${prefix}.${field} must be string[]`,
    );
  }
  return [...new Set(item as string[])];
}

function numericTtlSeconds(value: JsonValue, index: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      `service_bindings[${index}].grant_request.ttl_seconds must be a positive integer`,
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
