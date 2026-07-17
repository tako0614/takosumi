import type { JsonObject, JsonValue } from "./types.ts";
import { canonicalProviderSource } from "./provider-env-rules.ts";
import { containsSecretLikeString, isSecretKey } from "./redaction.ts";

export const PROVIDER_CONFIGURATIONS_FORMAT =
  "takosumi.provider-configurations@v1" as const;

export interface ProviderConfigurationEntry {
  /** Canonical OpenTofu/Terraform provider source address. */
  readonly provider: string;
  /** Explicit provider alias; null identifies the default provider block. */
  readonly alias: string | null;
  /** Validated non-secret provider-block arguments. */
  readonly configuration: JsonObject;
}

/**
 * Dispatch-only, non-secret ProviderBinding projection for lifecycle commands.
 *
 * This envelope never contains credential material. The `(provider, alias)`
 * tuple is the stable identity, so multiple aliases of the same provider do
 * not collapse into an ambiguous object map.
 */
export interface ProviderConfigurationsEnvelope {
  readonly format: typeof PROVIDER_CONFIGURATIONS_FORMAT;
  readonly providers: readonly ProviderConfigurationEntry[];
}

export interface ProviderConfigurationInput {
  readonly provider: string;
  readonly alias?: string | null;
  readonly configuration: Readonly<Record<string, JsonValue>>;
}

export function emptyProviderConfigurationsEnvelope(): ProviderConfigurationsEnvelope {
  return {
    format: PROVIDER_CONFIGURATIONS_FORMAT,
    providers: [],
  };
}

/**
 * Validates and canonicalizes an envelope before it crosses a runner boundary.
 * Object keys and provider entries are sorted recursively so JSON.stringify is
 * deterministic as well as the digest representation.
 */
export function providerConfigurationsEnvelope(
  entries: readonly ProviderConfigurationInput[],
): ProviderConfigurationsEnvelope {
  return parseProviderConfigurationsEnvelope({
    format: PROVIDER_CONFIGURATIONS_FORMAT,
    providers: entries.map((entry) => ({
      provider: entry.provider,
      alias: entry.alias ?? null,
      configuration: entry.configuration,
    })),
  });
}

export function parseProviderConfigurationsEnvelope(
  value: unknown,
): ProviderConfigurationsEnvelope {
  if (!isRecord(value)) {
    throw new Error("providerConfigurations must be a JSON object");
  }
  if (value.format !== PROVIDER_CONFIGURATIONS_FORMAT) {
    throw new Error(
      `providerConfigurations.format must be ${PROVIDER_CONFIGURATIONS_FORMAT}`,
    );
  }
  if (!Array.isArray(value.providers)) {
    throw new Error("providerConfigurations.providers must be an array");
  }

  const providers = value.providers
    .map((entry, index) => parseProviderConfigurationEntry(entry, index))
    .sort(compareProviderConfigurationEntries);
  const identities = new Set<string>();
  for (const entry of providers) {
    const identity = `${entry.provider}\0${entry.alias ?? ""}`;
    if (identities.has(identity)) {
      throw new Error(
        `providerConfigurations.providers contains duplicate provider/alias ${entry.provider}:${entry.alias ?? "<default>"}`,
      );
    }
    identities.add(identity);
  }
  return { format: PROVIDER_CONFIGURATIONS_FORMAT, providers };
}

export function providerConfigurationsJson(
  envelope: ProviderConfigurationsEnvelope,
): string {
  return JSON.stringify(parseProviderConfigurationsEnvelope(envelope));
}

function parseProviderConfigurationEntry(
  value: unknown,
  index: number,
): ProviderConfigurationEntry {
  const field = `providerConfigurations.providers[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  const provider =
    typeof value.provider === "string"
      ? canonicalProviderSource(value.provider)
      : "";
  if (!provider)
    throw new Error(`${field}.provider must be a non-empty string`);
  const alias = parseAlias(value.alias, `${field}.alias`);
  if (!isRecord(value.configuration)) {
    throw new Error(`${field}.configuration must be a JSON object`);
  }
  if (Object.keys(value.configuration).length === 0) {
    throw new Error(`${field}.configuration must not be empty`);
  }
  const configuration = canonicalNonSecretJsonObject(
    value.configuration,
    `${field}.configuration`,
    true,
  );
  return { provider, alias, configuration };
}

function parseAlias(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be null or a non-empty string`);
  }
  return value.trim();
}

function canonicalNonSecretJsonObject(
  value: Record<string, unknown>,
  path: string,
  providerArgumentKeys: boolean,
): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    if (providerArgumentKeys && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`${path}.${key} must be a valid provider argument name`);
    }
    if (isSecretKey(key)) {
      throw new Error(`${path}.${key} is secret-like and cannot be dispatched`);
    }
    out[key] = canonicalNonSecretJsonValue(value[key], `${path}.${key}`);
  }
  return out;
}

function canonicalNonSecretJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite JSON number`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (containsSecretLikeString(value)) {
      throw new Error(`${path} contains a secret-like value`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalNonSecretJsonValue(entry, `${path}[${index}]`),
    );
  }
  if (isRecord(value)) {
    return canonicalNonSecretJsonObject(value, path, false);
  }
  throw new Error(`${path} must be a JSON value`);
}

function compareProviderConfigurationEntries(
  left: ProviderConfigurationEntry,
  right: ProviderConfigurationEntry,
): number {
  const providerOrder = compareText(left.provider, right.provider);
  if (providerOrder !== 0) return providerOrder;
  if (left.alias === right.alias) return 0;
  if (left.alias === null) return -1;
  if (right.alias === null) return 1;
  return compareText(left.alias, right.alias);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
