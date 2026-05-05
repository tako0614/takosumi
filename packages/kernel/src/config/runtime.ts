import {
  EnvOperatorConfig,
  type OperatorConfigPort,
} from "../adapters/operator-config/mod.ts";
import { isPaaSProcessRole, type PaaSProcessRole } from "../process/mod.ts";
import type { JsonObject, KernelPluginPortKind } from "takosumi-contract";

export type RuntimeEnvironment =
  | "local"
  | "development"
  | "test"
  | "staging"
  | "production";

export type RuntimePluginSelection = Partial<
  Record<KernelPluginPortKind, string>
>;

export interface RuntimeRoutesConfig {
  readonly publicRoutesEnabled: boolean;
}

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly processRole: PaaSProcessRole;
  readonly allowUnsafeProductionDefaults: boolean;
  readonly plugins: RuntimePluginSelection;
  readonly pluginConfig: JsonObject;
  readonly routes: RuntimeRoutesConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
}

export interface RuntimeConfigDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly key?: string;
  readonly message: string;
}

export interface RuntimeConfigLoadOptions {
  readonly operatorConfig: OperatorConfigPort;
}

export interface RuntimeConfigEnvLoadOptions {
  readonly env?: Record<string, string | undefined>;
}

interface Selector<T extends string> {
  readonly value: T;
  readonly key?: string;
  readonly defaulted: boolean;
}

export class RuntimeConfigError extends Error {
  constructor(readonly diagnostics: readonly RuntimeConfigDiagnostic[]) {
    super(
      diagnostics.length === 1
        ? diagnostics[0].message
        : `runtime config has ${diagnostics.length} errors`,
    );
    this.name = "RuntimeConfigError";
  }
}

const DEFAULT_ENVIRONMENT = "local" satisfies RuntimeEnvironment;
const DEFAULT_PROCESS_ROLE = "takosumi-api" satisfies PaaSProcessRole;
export const PROCESS_ROLE_ENV_KEYS = [
  "TAKOSUMI_PAAS_PROCESS_ROLE",
  "TAKOSUMI_PROCESS_ROLE",
] as const;

const KERNEL_IO_PORTS = [
  "auth",
  "coordination",
  "notification",
  "operator-config",
  "storage",
  "source",
  "provider",
  "queue",
  "object-storage",
  "kms",
  "secret-store",
  "router-config",
  "observability",
  "runtime-agent",
] as const satisfies readonly KernelPluginPortKind[];

const OPTIONAL_KERNEL_IO_PORTS =
  [] as const satisfies readonly KernelPluginPortKind[];

const SELECTABLE_KERNEL_IO_PORTS = [
  ...KERNEL_IO_PORTS,
  ...OPTIONAL_KERNEL_IO_PORTS,
] as const satisfies readonly KernelPluginPortKind[];

const PORT_ENV_KEYS: Record<
  (typeof SELECTABLE_KERNEL_IO_PORTS)[number],
  readonly string[]
> = {
  auth: ["TAKOSUMI_AUTH_PLUGIN", "TAKOSUMI_AUTH_PLUGIN_ID"],
  coordination: [
    "TAKOSUMI_COORDINATION_PLUGIN",
    "TAKOSUMI_COORDINATION_PLUGIN_ID",
  ],
  notification: [
    "TAKOSUMI_NOTIFICATION_PLUGIN",
    "TAKOSUMI_NOTIFICATION_PLUGIN_ID",
  ],
  "operator-config": [
    "TAKOSUMI_OPERATOR_CONFIG_PLUGIN",
    "TAKOSUMI_OPERATOR_CONFIG_PLUGIN_ID",
  ],
  storage: ["TAKOSUMI_STORAGE_PLUGIN", "TAKOSUMI_STORAGE_PLUGIN_ID"],
  source: ["TAKOSUMI_SOURCE_PLUGIN", "TAKOSUMI_SOURCE_PLUGIN_ID"],
  provider: ["TAKOSUMI_PROVIDER_PLUGIN", "TAKOSUMI_PROVIDER_PLUGIN_ID"],
  queue: ["TAKOSUMI_QUEUE_PLUGIN", "TAKOSUMI_QUEUE_PLUGIN_ID"],
  "object-storage": [
    "TAKOSUMI_OBJECT_STORAGE_PLUGIN",
    "TAKOSUMI_OBJECT_STORAGE_PLUGIN_ID",
  ],
  kms: ["TAKOSUMI_KMS_PLUGIN", "TAKOSUMI_KMS_PLUGIN_ID"],
  "secret-store": [
    "TAKOSUMI_SECRET_STORE_PLUGIN",
    "TAKOSUMI_SECRET_STORE_PLUGIN_ID",
  ],
  "router-config": [
    "TAKOSUMI_ROUTER_CONFIG_PLUGIN",
    "TAKOSUMI_ROUTER_CONFIG_PLUGIN_ID",
  ],
  observability: [
    "TAKOSUMI_OBSERVABILITY_PLUGIN",
    "TAKOSUMI_OBSERVABILITY_PLUGIN_ID",
  ],
  "runtime-agent": [
    "TAKOSUMI_RUNTIME_AGENT_PLUGIN",
    "TAKOSUMI_RUNTIME_AGENT_PLUGIN_ID",
  ],
};

const STALE_SELECTOR_KEYS = [
  "TAKOSUMI_STORAGE_BACKEND",
  "TAKOSUMI_STORAGE_ADAPTER",
  "TAKOSUMI_PROVIDER",
  "TAKOSUMI_PROVIDER_ADAPTER",
  "TAKOSUMI_QUEUE_BACKEND",
  "TAKOSUMI_QUEUE_ADAPTER",
  "TAKOSUMI_OBJECT_STORAGE_BACKEND",
  "TAKOSUMI_OBJECT_STORAGE_ADAPTER",
  "TAKOSUMI_SOURCE",
  "TAKOSUMI_SOURCE_ADAPTER",
  "TAKOSUMI_KMS_BACKEND",
  "TAKOSUMI_KMS_ADAPTER",
  "TAKOSUMI_SECRET_STORE_BACKEND",
  "TAKOSUMI_SECRET_STORE_ADAPTER",
  "DATABASE_SECRET_REF",
  "TAKOSUMI_REDIS_URL",
  "REDIS_URL",
  "TAKOSUMI_S3_ENDPOINT",
  "S3_ENDPOINT",
  "AWS_S3_ENDPOINT",
  "TAKOSUMI_S3_BUCKET",
  "S3_BUCKET",
  "AWS_S3_BUCKET",
  "TAKOSUMI_OBJECT_STORAGE_URL",
  "TAKOSUMI_LOCAL_DOCKER_NETWORK",
  "TAKOS_GIT_BASE_URL",
  "TAKOSUMI_KMS_PROVIDER",
  "TAKOSUMI_KMS_KEY_ID",
  "TAKOSUMI_KMS_KEY_VERSION",
  "TAKOSUMI_SECRET_STORE_PROVIDER",
  "TAKOSUMI_SECRET_STORE_NAMESPACE",
  "TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER",
  "TAKOSUMI_BOOTSTRAP_SOURCE_ADAPTER",
  "TAKOSUMI_BOOTSTRAP_SECRET_ADAPTER",
  "TAKOSUMI_BOOTSTRAP_PROVIDER_ADAPTER",
] as const;

export async function loadRuntimeConfigFromEnv(
  options: RuntimeConfigEnvLoadOptions = {},
): Promise<RuntimeConfig> {
  return await loadRuntimeConfig({
    operatorConfig: new EnvOperatorConfig({ env: options.env }),
  });
}

export async function loadRuntimeConfig(
  options: RuntimeConfigLoadOptions,
): Promise<RuntimeConfig> {
  const reader = new OperatorConfigReader(options.operatorConfig);
  const diagnostics: RuntimeConfigDiagnostic[] = [];

  const environment = selectEnvironment(
    await reader.firstPlain([
      "TAKOSUMI_ENVIRONMENT",
      "NODE_ENV",
      "ENVIRONMENT",
    ]),
    diagnostics,
  );
  const processRole = await selectProcessRole(reader, diagnostics);
  const allowUnsafeProductionDefaults = parseBoolean(
    await reader.firstPlain(["TAKOSUMI_DEV_MODE"]),
    false,
  );

  await rejectStaleSelectors(reader, diagnostics);

  const plugins = await loadPluginSelection(reader, diagnostics);
  const pluginConfig = await loadPluginConfig(reader, diagnostics);
  const config: RuntimeConfig = {
    environment: environment.value,
    processRole: processRole.value,
    allowUnsafeProductionDefaults,
    plugins,
    pluginConfig,
    routes: {
      publicRoutesEnabled: parseBoolean(
        await reader.firstPlain(["TAKOSUMI_PUBLIC_ROUTES_ENABLED"]),
        false,
      ),
    },
    diagnostics,
  };

  validateRuntimeConfig(config);

  const errors = config.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new RuntimeConfigError(errors);
  return deepFreeze(config);
}

async function rejectStaleSelectors(
  reader: OperatorConfigReader,
  diagnostics: RuntimeConfigDiagnostic[],
): Promise<void> {
  for (const key of STALE_SELECTOR_KEYS) {
    const value = await reader.firstPlain([key]);
    if (!value) continue;
    diagnostics.push({
      severity: "error",
      code: "stale_runtime_selector",
      key,
      message:
        `${key} is no longer accepted by the PaaS kernel; select a kernel plugin port with TAKOSUMI_*_PLUGIN instead`,
    });
  }
}

async function loadPluginSelection(
  reader: OperatorConfigReader,
  diagnostics: RuntimeConfigDiagnostic[],
): Promise<RuntimePluginSelection> {
  const plugins: RuntimePluginSelection = {};
  const jsonSelection = await reader.firstPlain([
    "TAKOSUMI_KERNEL_PLUGIN_SELECTIONS",
    "TAKOSUMI_KERNEL_PLUGIN_MAP",
  ]);
  if (jsonSelection) {
    Object.assign(
      plugins,
      parsePluginSelectionJson(
        jsonSelection.value,
        jsonSelection.key,
        diagnostics,
      ),
    );
  }
  for (const port of SELECTABLE_KERNEL_IO_PORTS) {
    const selected = await reader.firstPlain(PORT_ENV_KEYS[port]);
    if (!selected) continue;
    plugins[port] = selected.value;
  }
  return plugins;
}

async function loadPluginConfig(
  reader: OperatorConfigReader,
  diagnostics: RuntimeConfigDiagnostic[],
): Promise<JsonObject> {
  const raw = await reader.firstPlain([
    "TAKOSUMI_KERNEL_PLUGIN_CONFIG",
    "TAKOSUMI_KERNEL_PLUGIN_CONFIG_JSON",
  ]);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw.value) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error("plugin config must be a JSON object");
    }
    return parsed;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "invalid_kernel_plugin_config_json",
      key: raw.key,
      message: error instanceof Error
        ? `${raw.key} must be valid JSON: ${error.message}`
        : `${raw.key} must be valid JSON`,
    });
    return {};
  }
}

function parsePluginSelectionJson(
  value: string,
  key: string,
  diagnostics: RuntimeConfigDiagnostic[],
): RuntimePluginSelection {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("selection must be an object");
    }
    const plugins: RuntimePluginSelection = {};
    for (const [rawPort, rawPluginId] of Object.entries(parsed)) {
      if (!isKernelIoPort(rawPort)) {
        diagnostics.push({
          severity: "error",
          code: "invalid_kernel_plugin_port",
          key,
          message: `${key} contains unsupported plugin port ${rawPort}`,
        });
        continue;
      }
      if (typeof rawPluginId !== "string" || !rawPluginId.trim()) {
        diagnostics.push({
          severity: "error",
          code: "invalid_kernel_plugin_id",
          key,
          message: `${key}.${rawPort} must be a non-empty plugin id`,
        });
        continue;
      }
      plugins[rawPort] = rawPluginId;
    }
    return plugins;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "invalid_kernel_plugin_selection_json",
      key,
      message: error instanceof Error
        ? `${key} must be valid JSON: ${error.message}`
        : `${key} must be valid JSON`,
    });
    return {};
  }
}

function validateRuntimeConfig(config: RuntimeConfig): void {
  const diagnostics = config.diagnostics as RuntimeConfigDiagnostic[];
  const strictEnvironment = config.environment === "production" ||
    config.environment === "staging";

  if (!strictEnvironment) return;

  for (const port of KERNEL_IO_PORTS) {
    const pluginId = config.plugins[port];
    if (!pluginId) {
      diagnostics.push({
        severity: "error",
        code: "kernel_plugin_port_missing",
        key: PORT_ENV_KEYS[port][0],
        message:
          `${config.environment} requires an explicit kernel plugin for port ${port}`,
      });
      continue;
    }
    if (isReferenceOrNoopPluginId(pluginId)) {
      diagnostics.push({
        severity: "error",
        code: "unsafe_kernel_plugin_selected",
        key: PORT_ENV_KEYS[port][0],
        message:
          `${config.environment} cannot select reference/noop kernel plugin ${pluginId} for port ${port}`,
      });
    }
  }
}

function isReferenceOrNoopPluginId(pluginId: string): boolean {
  const normalized = pluginId.trim().toLowerCase();
  return normalized === "takos.kernel.reference" ||
    /(^|[._-])noop([._-]|$)/.test(normalized) ||
    /(^|[._-])reference([._-]|$)/.test(normalized);
}

function selectEnvironment(
  raw: { readonly key: string; readonly value: string } | undefined,
  diagnostics: RuntimeConfigDiagnostic[],
): Selector<RuntimeEnvironment> {
  if (!raw) return { value: DEFAULT_ENVIRONMENT, defaulted: true };
  const normalized = normalizeToken(raw.value);
  if (isRuntimeEnvironment(normalized)) {
    return { value: normalized, key: raw.key, defaulted: false };
  }
  diagnostics.push({
    severity: "error",
    code: "invalid_environment",
    key: raw.key,
    message:
      `${raw.key} must be one of local, development, test, staging, production`,
  });
  return { value: DEFAULT_ENVIRONMENT, key: raw.key, defaulted: false };
}

async function selectProcessRole(
  reader: OperatorConfigReader,
  diagnostics: RuntimeConfigDiagnostic[],
): Promise<Selector<PaaSProcessRole>> {
  const values = await reader.allPlain(PROCESS_ROLE_ENV_KEYS);
  const raw = values[0];
  if (!raw) return { value: DEFAULT_PROCESS_ROLE, defaulted: true };

  const normalizedValues = values.map((value) => ({
    ...value,
    normalized: normalizeToken(value.value),
  }));
  const canonical = normalizedValues[0];
  const conflict = normalizedValues.find((value) =>
    value.normalized !== canonical.normalized
  );
  if (conflict) {
    diagnostics.push({
      severity: "error",
      code: "conflicting_process_role_env",
      key: conflict.key,
      message: `${conflict.key} conflicts with ${canonical.key}; set only ${
        PROCESS_ROLE_ENV_KEYS[0]
      } or use the same role value`,
    });
  }

  const normalized = normalizeToken(raw.value);
  if (isPaaSProcessRole(normalized)) {
    return { value: normalized, key: raw.key, defaulted: false };
  }
  diagnostics.push({
    severity: "error",
    code: "invalid_process_role",
    key: raw.key,
    message: `${raw.key} must be a known Takosumi process role`,
  });
  return { value: DEFAULT_PROCESS_ROLE, key: raw.key, defaulted: false };
}

function isRuntimeEnvironment(value: string): value is RuntimeEnvironment {
  return ["local", "development", "test", "staging", "production"].includes(
    value,
  );
}

function isKernelIoPort(
  value: string,
): value is (typeof SELECTABLE_KERNEL_IO_PORTS)[number] {
  return (SELECTABLE_KERNEL_IO_PORTS as readonly string[]).includes(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseBoolean(
  raw: { readonly value: string } | undefined,
  defaultValue: boolean,
): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

class OperatorConfigReader {
  constructor(readonly operatorConfig: OperatorConfigPort) {}

  async firstPlain(
    keys: readonly string[],
  ): Promise<{ readonly key: string; readonly value: string } | undefined> {
    for (const key of keys) {
      const value = await this.operatorConfig.get(key);
      if (value?.kind === "plain") return { key, value: value.value };
    }
    return undefined;
  }

  async allPlain(
    keys: readonly string[],
  ): Promise<readonly { readonly key: string; readonly value: string }[]> {
    const values: { readonly key: string; readonly value: string }[] = [];
    for (const key of keys) {
      const value = await this.operatorConfig.get(key);
      if (value?.kind === "plain") values.push({ key, value: value.value });
    }
    return values;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
