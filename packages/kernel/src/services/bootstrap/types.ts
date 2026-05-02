import type { AuthPort } from "../../adapters/auth/mod.ts";
import type { OperatorConfigSnapshot } from "../../adapters/operator-config/mod.ts";
import type { ProviderMaterializer } from "../../adapters/provider/mod.ts";
import type { SecretStorePort } from "../../adapters/secret-store/mod.ts";
import type { SourcePort } from "../../adapters/source/mod.ts";
import type { ObservabilitySink } from "../observability/sink.ts";

export type BootstrapSeverity = "warning" | "error";

export interface BootstrapDiagnostic {
  readonly severity: BootstrapSeverity;
  readonly code: string;
  readonly message: string;
  readonly key?: string;
}

export type BootstrapAdapterFamily =
  | "auth"
  | "source"
  | "secret"
  | "provider"
  | "observability";

export interface BootstrapAdapterSelection {
  readonly family: BootstrapAdapterFamily;
  readonly kind: string;
  readonly configuredBy: readonly string[];
  readonly defaulted: boolean;
}

export interface BootstrapRedactedConfigValue {
  readonly key: string;
  readonly source: "env" | "local" | "effective";
  readonly kind: "plain" | "secret-ref";
  readonly value?: string;
  readonly ref?: {
    readonly name: string;
    readonly version?: string;
  };
  readonly redacted?: true;
}

export interface BootstrapRedactedConfig {
  readonly generatedAt: string;
  readonly values: readonly BootstrapRedactedConfigValue[];
}

export interface BootstrapAdapters {
  readonly auth: AuthPort;
  readonly source: SourcePort;
  readonly secretStore: SecretStorePort;
  readonly provider: ProviderMaterializer;
  readonly observability: ObservabilitySink;
}

export interface BootstrapReport {
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly environment: string;
  readonly allowUnsafeDefaults: boolean;
  readonly selectedAdapters: readonly BootstrapAdapterSelection[];
  readonly warnings: readonly BootstrapDiagnostic[];
  readonly errors: readonly BootstrapDiagnostic[];
  readonly config: BootstrapRedactedConfig;
  readonly adapters: BootstrapAdapters;
  readonly operatorConfigSnapshot: OperatorConfigSnapshot;
}
