import {
  type AuthPort,
  LocalActorAdapter,
  ServiceActorAuthAdapter,
} from "../../adapters/auth/mod.ts";
import type {
  OperatorConfigPort,
  OperatorConfigSnapshot,
  OperatorConfigValue,
} from "../../adapters/operator-config/mod.ts";
import {
  NoopProviderMaterializer,
  type ProviderMaterializer,
} from "../../adapters/provider/mod.ts";
import {
  MemoryEncryptedSecretStore,
  SecretEncryptionConfigurationError,
  type SecretRecord,
  type SecretStorePort,
  type SecretVersionRef,
  selectSecretBoundaryCrypto,
} from "../../adapters/secret-store/mod.ts";
import {
  ImmutableManifestSourceAdapter,
  type SourcePort,
} from "../../adapters/source/mod.ts";
import {
  InMemoryObservabilitySink,
  type ObservabilitySink,
  SqlObservabilitySink,
} from "../observability/mod.ts";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import { isDevMode } from "../../config/dev_mode.ts";
import type {
  BootstrapAdapterFamily,
  BootstrapAdapterSelection,
  BootstrapDiagnostic,
  BootstrapRedactedConfig,
  BootstrapRedactedConfigValue,
  BootstrapReport,
} from "./types.ts";

export interface StandaloneBootstrapServiceOptions {
  readonly operatorConfig: OperatorConfigPort;
  readonly clock?: () => Date;
  /**
   * Optional SQL client for the SQL-backed observability (audit) sink.
   * When omitted, `observability=sql` is rejected as a configuration error.
   */
  readonly sqlClient?: SqlClient;
}

type SelectorSpec = {
  readonly family: BootstrapAdapterFamily;
  readonly key: string;
  readonly defaultKind: string;
};

const SELECTORS: readonly SelectorSpec[] = [
  {
    family: "auth",
    key: "TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER",
    defaultKind: "local",
  },
  {
    family: "source",
    key: "TAKOSUMI_BOOTSTRAP_SOURCE_ADAPTER",
    defaultKind: "manifest",
  },
  {
    family: "secret",
    key: "TAKOSUMI_BOOTSTRAP_SECRET_ADAPTER",
    defaultKind: "memory",
  },
  {
    family: "provider",
    key: "TAKOSUMI_BOOTSTRAP_PROVIDER_ADAPTER",
    defaultKind: "noop",
  },
  {
    family: "observability",
    key: "TAKOSUMI_BOOTSTRAP_OBSERVABILITY_ADAPTER",
    defaultKind: "memory",
  },
];

const STALE_BOOTSTRAP_SELECTOR_KEYS = [
  "TAKOSUMI_AUTH_ADAPTER",
  "TAKOSUMI_SOURCE_ADAPTER",
  "TAKOSUMI_SECRET_STORE_ADAPTER",
  "TAKOSUMI_PROVIDER_ADAPTER",
] as const;

export class StandaloneBootstrapService {
  readonly #operatorConfig: OperatorConfigPort;
  readonly #clock: () => Date;
  readonly #sqlClient: SqlClient | undefined;

  constructor(options: StandaloneBootstrapServiceOptions) {
    this.#operatorConfig = options.operatorConfig;
    this.#clock = options.clock ?? (() => new Date());
    this.#sqlClient = options.sqlClient;
  }

  async bootstrap(): Promise<BootstrapReport> {
    const generatedAt = this.#clock().toISOString();
    const snapshot = await this.#operatorConfig.snapshot();
    const warnings: BootstrapDiagnostic[] = [];
    const errors: BootstrapDiagnostic[] = [];
    const environment = normalizeEnvironment(
      await this.#plainValue([
        "TAKOSUMI_ENVIRONMENT",
        "NODE_ENV",
        "ENVIRONMENT",
      ]),
    );
    const devModeFlag = await this.#plainValue(["TAKOSUMI_DEV_MODE"]);
    const allowUnsafeDefaults = isDevMode({ TAKOSUMI_DEV_MODE: devModeFlag });
    await this.#rejectStaleSelectors(errors);

    const selectedAdapters: BootstrapAdapterSelection[] = [];
    for (const selector of SELECTORS) {
      selectedAdapters.push(
        await this.#select(
          environmentDefault(selector, environment),
          warnings,
          errors,
        ),
      );
    }

    const adapters = this.#createAdapters(
      selectedAdapters,
      errors,
      snapshot,
      environment,
    );
    this.#validateUnsafeDefaults({
      environment,
      allowUnsafeDefaults,
      selectedAdapters,
      warnings,
      errors,
      snapshot,
    });

    return deepFreeze({
      ok: errors.length === 0,
      generatedAt,
      environment,
      allowUnsafeDefaults,
      selectedAdapters,
      warnings,
      errors,
      config: redactConfig(snapshot, selectedAdapters, generatedAt),
      adapters,
      operatorConfigSnapshot: redactOperatorConfigSnapshot(snapshot),
    });
  }

  async #select(
    spec: SelectorSpec,
    warnings: BootstrapDiagnostic[],
    errors: BootstrapDiagnostic[],
  ): Promise<BootstrapAdapterSelection> {
    const configured: string[] = [];
    let raw: string | undefined;

    for (const key of [spec.key]) {
      const value = await this.#operatorConfig.get(key);
      if (!value) continue;
      configured.push(key);
      if (value.kind === "secret-ref") {
        errors.push({
          severity: "error",
          code: "selector_secret_ref_unsupported",
          key,
          message: `${key} must be a plain adapter selector, not a secret ref`,
        });
        continue;
      }
      raw ??= value.value;
    }

    const defaulted = raw === undefined;
    const kind = normalizeAdapterKind(raw ?? spec.defaultKind);
    if (defaulted) {
      warnings.push({
        severity: "warning",
        code: "adapter_selector_defaulted",
        key: spec.key,
        message: `${spec.family} adapter defaulted to ${kind}`,
      });
    }
    return Object.freeze({
      family: spec.family,
      kind,
      configuredBy: Object.freeze(configured),
      defaulted,
    });
  }

  #createAdapters(
    selections: readonly BootstrapAdapterSelection[],
    errors: BootstrapDiagnostic[],
    snapshot: OperatorConfigSnapshot,
    environment: string,
  ): {
    readonly auth: AuthPort;
    readonly source: SourcePort;
    readonly secretStore: SecretStorePort;
    readonly provider: ProviderMaterializer;
    readonly observability: ObservabilitySink;
  } {
    return {
      auth: this.#createAuth(
        selectionKind(selections, "auth"),
        errors,
        snapshot,
      ),
      source: this.#createSource(selectionKind(selections, "source"), errors),
      secretStore: this.#createSecretStore(
        selectionKind(selections, "secret"),
        errors,
        snapshot,
      ),
      provider: this.#createProvider(
        selectionKind(selections, "provider"),
        errors,
        snapshot,
      ),
      observability: this.#createObservability(
        selectionKind(selections, "observability"),
        errors,
        snapshot,
        environment,
      ),
    };
  }

  #createObservability(
    kind: string,
    errors: BootstrapDiagnostic[],
    snapshot: OperatorConfigSnapshot,
    environment: string,
  ): ObservabilitySink {
    const productionLike = environment === "production" ||
      environment === "staging";
    if (kind === "memory") {
      if (productionLike) {
        errors.push({
          severity: "error",
          code: "observability_memory_forbidden_in_production",
          key: "TAKOSUMI_BOOTSTRAP_OBSERVABILITY_ADAPTER",
          message:
            `${environment} requires sql-backed audit sink for compliance (SOX/HIPAA); set TAKOSUMI_BOOTSTRAP_OBSERVABILITY_ADAPTER=sql`,
        });
      }
      return new InMemoryObservabilitySink();
    }
    if (kind === "sql") {
      if (!this.#sqlClient) {
        errors.push({
          severity: "error",
          code: "observability_sql_client_missing",
          key: "TAKOSUMI_BOOTSTRAP_OBSERVABILITY_ADAPTER",
          message:
            "sql observability adapter requires a SqlClient to be supplied via StandaloneBootstrapService options",
        });
        return new InMemoryObservabilitySink();
      }
      const retentionRaw = snapshotPlainValue(
        snapshot,
        "TAKOSUMI_AUDIT_RETENTION_DAYS",
      );
      const retentionDays = retentionRaw ? Number(retentionRaw) : undefined;
      return new SqlObservabilitySink({
        client: this.#sqlClient,
        clock: this.#clock,
        auditRetentionDays: Number.isFinite(retentionDays) && retentionDays
          ? retentionDays
          : undefined,
      });
    }
    errors.push(unsupportedAdapter("observability", kind, ["memory", "sql"]));
    return new InMemoryObservabilitySink();
  }

  #createAuth(
    kind: string,
    errors: BootstrapDiagnostic[],
    snapshot: OperatorConfigSnapshot,
  ): AuthPort {
    if (kind === "local") return new LocalActorAdapter();
    if (kind === "service") {
      const secret = snapshotPlainValue(
        snapshot,
        "TAKOSUMI_INTERNAL_API_SECRET",
      ) ?? snapshotPlainValue(
        snapshot,
        "TAKOSUMI_INTERNAL_SERVICE_SECRET",
      );
      if (!secret) {
        errors.push({
          severity: "error",
          code: "auth_service_secret_missing",
          key: "TAKOSUMI_INTERNAL_API_SECRET",
          message: "service auth requires TAKOSUMI_INTERNAL_API_SECRET",
        });
        return new LocalActorAdapter();
      }
      return new ServiceActorAuthAdapter({ secret, clock: this.#clock });
    }
    errors.push(unsupportedAdapter("auth", kind, ["local", "service"]));
    return new LocalActorAdapter();
  }

  #createSource(kind: string, errors: BootstrapDiagnostic[]): SourcePort {
    if (kind === "manifest" || kind === "immutable-manifest") {
      return new ImmutableManifestSourceAdapter({ clock: this.#clock });
    }
    errors.push(unsupportedAdapter("source", kind, [
      "manifest",
    ]));
    return new ImmutableManifestSourceAdapter({ clock: this.#clock });
  }

  #createSecretStore(
    kind: string,
    errors: BootstrapDiagnostic[],
    snapshot: OperatorConfigSnapshot,
  ): SecretStorePort {
    if (kind === "memory") {
      return this.#createMemorySecretStore(errors, snapshot);
    }
    errors.push(unsupportedAdapter("secret", kind, ["memory"]));
    return this.#createMemorySecretStore(errors, snapshot);
  }

  #createMemorySecretStore(
    errors: BootstrapDiagnostic[],
    snapshot: OperatorConfigSnapshot,
  ): SecretStorePort {
    const env = bootstrapCryptoEnv(snapshot);
    try {
      const crypto = selectSecretBoundaryCrypto({ env });
      return new MemoryEncryptedSecretStore({
        clock: this.#clock,
        crypto,
      });
    } catch (error) {
      if (error instanceof SecretEncryptionConfigurationError) {
        errors.push({
          severity: "error",
          code: "secret_store_encryption_key_missing",
          key: "TAKOSUMI_SECRET_STORE_PASSPHRASE",
          message: error.message,
        });
        return new FailingSecretStore(error.message);
      }
      throw error;
    }
  }

  #createProvider(
    kind: string,
    errors: BootstrapDiagnostic[],
    _snapshot: OperatorConfigSnapshot,
  ): ProviderMaterializer {
    if (kind === "noop") {
      return new NoopProviderMaterializer({ clock: this.#clock });
    }
    errors.push(unsupportedAdapter("provider", kind, ["noop"]));
    return new NoopProviderMaterializer({ clock: this.#clock });
  }

  #validateUnsafeDefaults(input: {
    readonly environment: string;
    readonly allowUnsafeDefaults: boolean;
    readonly selectedAdapters: readonly BootstrapAdapterSelection[];
    readonly warnings: BootstrapDiagnostic[];
    readonly errors: BootstrapDiagnostic[];
    readonly snapshot: OperatorConfigSnapshot;
  }): void {
    const unsafeFamilies = new Set<BootstrapAdapterFamily>([
      "auth",
      "secret",
      "provider",
    ]);
    const productionLikeEnvironment = ["production", "staging"].includes(
      input.environment,
    );
    const localEnvironment = ["local", "dev", "development", "test"]
      .includes(input.environment);
    const unsafeAllowedAsWarning = localEnvironment ||
      (input.allowUnsafeDefaults && !productionLikeEnvironment);
    for (const selection of input.selectedAdapters) {
      if (!unsafeFamilies.has(selection.family)) continue;
      if (
        productionLikeEnvironment && selection.family === "provider" &&
        (selection.kind === "local-docker" || selection.kind === "noop")
      ) {
        input.errors.push({
          severity: "error",
          code: "production_provider_bootstrap_forbidden",
          key: selection.configuredBy[0],
          message:
            `${input.environment} cannot bootstrap provider adapter ${selection.kind}; select a non-reference provider kernel plugin or inject an operator-owned provider`,
        });
        continue;
      }
      if (["local", "memory", "noop"].includes(selection.kind)) {
        const diagnostic: BootstrapDiagnostic = {
          severity: unsafeAllowedAsWarning ? "warning" : "error",
          code: "unsafe_adapter_selected",
          key: selection.configuredBy[0],
          message:
            `${selection.family} adapter ${selection.kind} is only safe for local standalone bootstrap`,
        };
        if (diagnostic.severity === "error") input.errors.push(diagnostic);
        else input.warnings.push(diagnostic);
      }
    }

    for (
      const key of [
        "TAKOSUMI_INTERNAL_API_SECRET",
        "TAKOSUMI_INTERNAL_SERVICE_SECRET",
        "TAKOSUMI_SECRET_STORE_PASSPHRASE",
        "EXECUTOR_PROXY_SECRET",
      ]
    ) {
      const value = snapshotPlainValue(input.snapshot, key);
      if (value && isUnsafeSecretValue(value)) {
        const diagnostic: BootstrapDiagnostic = {
          severity: unsafeAllowedAsWarning ? "warning" : "error",
          code: "unsafe_secret_value",
          key,
          message: `${key} uses an unsafe placeholder value`,
        };
        if (diagnostic.severity === "error") input.errors.push(diagnostic);
        else input.warnings.push(diagnostic);
      }
    }
  }

  async #plainValue(keys: readonly string[]): Promise<string | undefined> {
    for (const key of keys) {
      const value = await this.#operatorConfig.get(key);
      if (value?.kind === "plain") return value.value;
    }
    return undefined;
  }

  async #rejectStaleSelectors(errors: BootstrapDiagnostic[]): Promise<void> {
    for (const key of STALE_BOOTSTRAP_SELECTOR_KEYS) {
      const value = await this.#operatorConfig.get(key);
      if (!value) continue;
      errors.push({
        severity: "error",
        code: "stale_bootstrap_selector",
        key,
        message:
          `${key} is a stale standalone bootstrap selector; select a kernel plugin port with TAKOSUMI_*_PLUGIN instead`,
      });
    }
  }
}

class FailingSecretStore implements SecretStorePort {
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  putSecret(): Promise<SecretRecord> {
    return Promise.reject(
      new SecretEncryptionConfigurationError(this.#message),
    );
  }

  getSecret(): Promise<string | undefined> {
    return Promise.reject(
      new SecretEncryptionConfigurationError(this.#message),
    );
  }

  getSecretRecord(): Promise<SecretRecord | undefined> {
    return Promise.reject(
      new SecretEncryptionConfigurationError(this.#message),
    );
  }

  latestSecret(): Promise<SecretRecord | undefined> {
    return Promise.reject(
      new SecretEncryptionConfigurationError(this.#message),
    );
  }

  listSecrets(): Promise<readonly SecretRecord[]> {
    return Promise.reject(
      new SecretEncryptionConfigurationError(this.#message),
    );
  }

  deleteSecret(_ref: SecretVersionRef): Promise<boolean> {
    return Promise.reject(
      new SecretEncryptionConfigurationError(this.#message),
    );
  }
}

function snapshotPlainValue(
  snapshot: OperatorConfigSnapshot,
  key: string,
): string | undefined {
  const value = snapshot.values.find((item) => item.key === key);
  return value?.kind === "plain" ? value.value : undefined;
}

function bootstrapCryptoEnv(
  snapshot: OperatorConfigSnapshot,
): Readonly<Record<string, string | undefined>> {
  const keys = [
    "TAKOSUMI_ENVIRONMENT",
    "NODE_ENV",
    "ENVIRONMENT",
    "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    "TAKOSUMI_SECRET_STORE_KEY",
    "TAKOSUMI_SECRET_ENCRYPTION_KEY",
    "ENCRYPTION_KEY",
    "TAKOSUMI_DEV_MODE",
  ] as const;
  const env: Record<string, string | undefined> = {};
  for (const key of keys) env[key] = snapshotPlainValue(snapshot, key);
  return Object.freeze(env);
}

function selectionKind(
  selections: readonly BootstrapAdapterSelection[],
  family: BootstrapAdapterFamily,
): string {
  return selections.find((selection) => selection.family === family)?.kind ??
    "";
}

function unsupportedAdapter(
  family: BootstrapAdapterFamily,
  kind: string,
  supported: readonly string[],
): BootstrapDiagnostic {
  return {
    severity: "error",
    code: "unsupported_adapter",
    message: `${family} adapter ${kind} is unsupported; supported: ${
      supported.join(", ")
    }`,
  };
}

function normalizeEnvironment(raw: string | undefined): string {
  return (raw ?? "local").trim().toLowerCase() || "local";
}

function environmentDefault(
  spec: SelectorSpec,
  environment: string,
): SelectorSpec {
  if (spec.family !== "observability") return spec;
  const productionLike = environment === "production" ||
    environment === "staging";
  return productionLike ? { ...spec, defaultKind: "sql" } : spec;
}

function normalizeAdapterKind(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("_", "-");
}

function redactConfig(
  snapshot: OperatorConfigSnapshot,
  selections: readonly BootstrapAdapterSelection[],
  generatedAt: string,
): BootstrapRedactedConfig {
  const values = new Map<string, BootstrapRedactedConfigValue>();
  for (const value of snapshot.values) {
    values.set(value.key, redactValue(value));
  }
  for (const selection of selections) {
    const key = `BOOTSTRAP_SELECTED_${selection.family.toUpperCase()}_ADAPTER`;
    values.set(key, {
      key,
      source: "effective",
      kind: "plain",
      value: selection.kind,
    });
  }
  return Object.freeze({
    generatedAt,
    values: Object.freeze(
      [...values.values()].sort((a, b) => a.key.localeCompare(b.key)),
    ),
  });
}

function redactOperatorConfigSnapshot(
  snapshot: OperatorConfigSnapshot,
): OperatorConfigSnapshot {
  return Object.freeze({
    generatedAt: snapshot.generatedAt,
    values: Object.freeze(snapshot.values.map(redactOperatorConfigValue)),
  });
}

function redactOperatorConfigValue(
  value: OperatorConfigValue,
): OperatorConfigValue {
  if (value.kind === "secret-ref") return Object.freeze(structuredClone(value));
  if (!isSensitiveKey(value.key)) return Object.freeze({ ...value });
  return Object.freeze({
    ...value,
    value: "[REDACTED]",
  });
}

function redactValue(value: OperatorConfigValue): BootstrapRedactedConfigValue {
  if (value.kind === "secret-ref") {
    return {
      key: value.key,
      source: value.source,
      kind: "secret-ref",
      ref: { ...value.ref },
      redacted: true,
    };
  }
  if (isSensitiveKey(value.key)) {
    return {
      key: value.key,
      source: value.source,
      kind: "plain",
      value: "[REDACTED]",
      redacted: true,
    };
  }
  return {
    key: value.key,
    source: value.source,
    kind: "plain",
    value: value.value,
  };
}

function isSensitiveKey(key: string): boolean {
  return /(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|ACCESS_KEY)/i.test(key);
}

function isUnsafeSecretValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "replace-me" ||
    normalized === "changeme" || normalized === "change-me" ||
    normalized === "password" || normalized === "secret" ||
    normalized === "dev-secret";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
