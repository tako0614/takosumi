/**
 * Runtime configuration loader for the Takosumi service.
 *
 * The service reads only minimal env-derived knobs here: environment
 * (`local` / `development` / `test` / `staging` / `production`) and
 * process role. Backend implementation selection is no longer driven by env
 * vars; operators inject implementation bindings through service construction.
 * Legacy backend / adapter selectors are rejected to keep configuration clean.
 */
import {
  EnvOperatorConfig,
  type OperatorConfigPort,
} from "../adapters/operator-config/mod.ts";
import { isTakosumiProcessRole, type TakosumiProcessRole } from "../process/mod.ts";

export type RuntimeEnvironment =
  | "local"
  | "development"
  | "test"
  | "staging"
  | "production";

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly processRole: TakosumiProcessRole;
  readonly allowUnsafeProductionDefaults: boolean;
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
const DEFAULT_PROCESS_ROLE = "takosumi-api" satisfies TakosumiProcessRole;
export const PROCESS_ROLE_ENV_KEYS = [
  "TAKOSUMI_PROCESS_ROLE",
] as const;

/**
 * Hard-break selectors retained as runtime errors so existing operator
 * configurations get a clear message ("inject implementation bindings") instead
 * of silently doing the wrong thing. Includes both legacy adapter
 * selectors and the now-retired env-based implementation selectors.
 */
const STALE_SELECTOR_KEYS = [
  "TAKOSUMI_STORAGE_BACKEND",
  "TAKOSUMI_STORAGE_ADAPTER",
  "TAKOSUMI_STORAGE_PLUGIN",
  "TAKOSUMI_STORAGE_PLUGIN_ID",
  "TAKOSUMI_PROVIDER",
  "TAKOSUMI_PROVIDER_ADAPTER",
  "TAKOSUMI_PROVIDER_PLUGIN",
  "TAKOSUMI_PROVIDER_PLUGIN_ID",
  "TAKOSUMI_QUEUE_BACKEND",
  "TAKOSUMI_QUEUE_ADAPTER",
  "TAKOSUMI_QUEUE_PLUGIN",
  "TAKOSUMI_QUEUE_PLUGIN_ID",
  "TAKOSUMI_OBJECT_STORAGE_BACKEND",
  "TAKOSUMI_OBJECT_STORAGE_ADAPTER",
  "TAKOSUMI_OBJECT_STORAGE_PLUGIN",
  "TAKOSUMI_OBJECT_STORAGE_PLUGIN_ID",
  "TAKOSUMI_SOURCE",
  "TAKOSUMI_SOURCE_ADAPTER",
  "TAKOSUMI_SOURCE_PLUGIN",
  "TAKOSUMI_SOURCE_PLUGIN_ID",
  "TAKOSUMI_AUTH_PLUGIN",
  "TAKOSUMI_AUTH_PLUGIN_ID",
  "TAKOSUMI_COORDINATION_PLUGIN",
  "TAKOSUMI_COORDINATION_PLUGIN_ID",
  "TAKOSUMI_NOTIFICATION_PLUGIN",
  "TAKOSUMI_NOTIFICATION_PLUGIN_ID",
  "TAKOSUMI_OPERATOR_CONFIG_PLUGIN",
  "TAKOSUMI_OPERATOR_CONFIG_PLUGIN_ID",
  "TAKOSUMI_KMS_BACKEND",
  "TAKOSUMI_KMS_ADAPTER",
  "TAKOSUMI_KMS_PLUGIN",
  "TAKOSUMI_KMS_PLUGIN_ID",
  "TAKOSUMI_SECRET_STORE_BACKEND",
  "TAKOSUMI_SECRET_STORE_ADAPTER",
  "TAKOSUMI_SECRET_STORE_PLUGIN",
  "TAKOSUMI_SECRET_STORE_PLUGIN_ID",
  "TAKOSUMI_ROUTER_CONFIG_PLUGIN",
  "TAKOSUMI_ROUTER_CONFIG_PLUGIN_ID",
  "TAKOSUMI_OBSERVABILITY_PLUGIN",
  "TAKOSUMI_OBSERVABILITY_PLUGIN_ID",
  "TAKOSUMI_RUNTIME_AGENT_PLUGIN",
  "TAKOSUMI_RUNTIME_AGENT_PLUGIN_ID",
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

  const config: RuntimeConfig = {
    environment: environment.value,
    processRole: processRole.value,
    allowUnsafeProductionDefaults,
    diagnostics,
  };

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
        `${key} is no longer accepted by the Takosumi service; inject operator-owned implementation bindings through service construction instead`,
    });
  }
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
): Promise<Selector<TakosumiProcessRole>> {
  const values = await reader.allPlain(PROCESS_ROLE_ENV_KEYS);
  const raw = values[0];
  if (!raw) return { value: DEFAULT_PROCESS_ROLE, defaulted: true };

  const normalized = normalizeToken(raw.value);
  if (isTakosumiProcessRole(normalized)) {
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
