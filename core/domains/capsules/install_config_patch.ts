import type {
  InstallConfigInstallExperience,
  InstallConfigInstallProjection,
  InstallConfigLifecycleAction,
  InstallConfigPatchV1,
  InstallConfigVariableDefault,
  InstallConfigVariablePresentation,
  OutputAllowlistEntry,
  PolicyConfig,
} from "takosumi-contract/install-configs";
import { INSTALL_CONFIG_PATCH_V1_KIND } from "takosumi-contract/install-configs";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract/interfaces";
import type { JsonValue } from "takosumi-contract";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const TOKEN = /^[A-Za-z][A-Za-z0-9._:-]*$/u;

/**
 * Parse the operator-selected versioned patch artifact without accepting a
 * repository manifest, an unknown artifact version, or silently ignored
 * fields. Domain validation still runs when the resulting InstallConfig is
 * persisted.
 */
export function parseInstallConfigPatchV1(
  value: unknown,
): InstallConfigPatchV1 {
  const record = objectValue(value, "InstallConfig patch");
  exactKeys(record, "InstallConfig patch", [
    "kind",
    "variableMapping",
    "variablePresentation",
    "installExperience",
    "outputAllowlist",
    "interfaceBlueprints",
    "lifecycleActions",
    "lifecycleActionPolicy",
  ]);
  if (record.kind !== INSTALL_CONFIG_PATCH_V1_KIND) {
    throw invalid(
      `InstallConfig patch kind must be ${INSTALL_CONFIG_PATCH_V1_KIND}`,
    );
  }
  const mutableFields = Object.keys(record).filter((key) => key !== "kind");
  if (mutableFields.length === 0) {
    throw invalid(
      "InstallConfig patch must contain at least one mutable field",
    );
  }

  return {
    kind: INSTALL_CONFIG_PATCH_V1_KIND,
    ...(has(record, "variableMapping")
      ? {
          variableMapping: jsonRecord(
            record.variableMapping,
            "variableMapping",
          ),
        }
      : {}),
    ...(has(record, "variablePresentation")
      ? {
          variablePresentation: variablePresentationValue(
            record.variablePresentation,
          ),
        }
      : {}),
    ...(has(record, "installExperience")
      ? { installExperience: installExperienceValue(record.installExperience) }
      : {}),
    ...(has(record, "outputAllowlist")
      ? { outputAllowlist: outputAllowlistValue(record.outputAllowlist) }
      : {}),
    ...(has(record, "interfaceBlueprints")
      ? {
          interfaceBlueprints: interfaceBlueprintsValue(
            record.interfaceBlueprints,
          ),
        }
      : {}),
    ...(has(record, "lifecycleActions")
      ? { lifecycleActions: lifecycleActionsValue(record.lifecycleActions) }
      : {}),
    ...(has(record, "lifecycleActionPolicy")
      ? {
          lifecycleActionPolicy:
            record.lifecycleActionPolicy === null
              ? null
              : lifecycleActionPolicyValue(record.lifecycleActionPolicy),
        }
      : {}),
  };
}

function variablePresentationValue(
  value: unknown,
): readonly InstallConfigVariablePresentation[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw invalid(
      "variablePresentation must be an array with at most 50 entries",
    );
  }
  return value.map((item, index) => {
    const field = `variablePresentation[${index}]`;
    const record = objectValue(item, field);
    exactKeys(record, field, [
      "name",
      "type",
      "format",
      "required",
      "advanced",
      "secret",
      "defaultValue",
      "label",
      "helper",
      "placeholder",
    ]);
    const name = tokenValue(record.name, `${field}.name`, 64, VARIABLE_NAME);
    const type = optionalEnum(record, "type", field, [
      "string",
      "number",
      "boolean",
      "json",
    ] as const);
    const format = optionalToken(record, "format", field, 64);
    const required = optionalBoolean(record, "required", field);
    const advanced = optionalBoolean(record, "advanced", field);
    const secret = optionalBoolean(record, "secret", field);
    const defaultValue = has(record, "defaultValue")
      ? defaultValueValue(record.defaultValue, `${field}.defaultValue`)
      : undefined;
    const label = localizedTextValue(record.label, `${field}.label`);
    const helper = has(record, "helper")
      ? localizedTextValue(record.helper, `${field}.helper`)
      : undefined;
    const placeholder = has(record, "placeholder")
      ? stringValue(record.placeholder, `${field}.placeholder`, 256)
      : undefined;
    return {
      name,
      ...(type ? { type } : {}),
      ...(format ? { format } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(advanced !== undefined ? { advanced } : {}),
      ...(secret !== undefined ? { secret } : {}),
      ...(defaultValue ? { defaultValue } : {}),
      label,
      ...(helper ? { helper } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
    };
  });
}

function defaultValueValue(
  value: unknown,
  field: string,
): InstallConfigVariableDefault {
  const record = objectValue(value, field);
  if (record.source === "literal") {
    exactKeys(record, field, ["source", "value"]);
    if (!has(record, "value") || !isJsonValue(record.value)) {
      throw invalid(`${field}.value must be JSON`);
    }
    return { source: "literal", value: record.value };
  }
  if (
    record.source === "capsule_name" ||
    record.source === "workspace_scoped_capsule_name"
  ) {
    exactKeys(record, field, ["source"]);
    return { source: record.source };
  }
  throw invalid(`${field}.source is unsupported`);
}

function installExperienceValue(
  value: unknown,
): InstallConfigInstallExperience {
  const record = objectValue(value, "installExperience");
  exactKeys(record, "installExperience", ["projections"]);
  if (!has(record, "projections")) return {};
  if (!Array.isArray(record.projections) || record.projections.length > 20) {
    throw invalid(
      "installExperience.projections must contain at most 20 entries",
    );
  }
  return {
    projections: record.projections.map((item, index) =>
      installProjectionValue(item, index),
    ),
  };
}

function installProjectionValue(
  value: unknown,
  index: number,
): InstallConfigInstallProjection {
  const field = `installExperience.projections[${index}]`;
  const record = objectValue(value, field);
  switch (record.kind) {
    case "service_name":
      exactKeys(record, field, ["kind", "variable"]);
      return {
        kind: "service_name",
        variable: variableNameValue(record.variable, `${field}.variable`),
      };
    case "public_endpoint": {
      exactKeys(record, field, ["kind", "variables", "baseDomain"]);
      const variables = variablesValue(record.variables, `${field}.variables`, [
        "subdomain",
        "url",
        "routePattern",
      ]);
      const baseDomain = has(record, "baseDomain")
        ? stringValue(record.baseDomain, `${field}.baseDomain`, 255)
        : undefined;
      return {
        kind: "public_endpoint",
        variables,
        ...(baseDomain ? { baseDomain } : {}),
      };
    }
    case "initial_secret": {
      exactKeys(record, field, ["kind", "variable", "secretKind", "optional"]);
      const secretKind = optionalEnum(record, "secretKind", field, [
        "password",
        "password_or_hash",
        "token",
      ] as const);
      const optional = optionalBoolean(record, "optional", field);
      return {
        kind: "initial_secret",
        variable: variableNameValue(record.variable, `${field}.variable`),
        ...(secretKind ? { secretKind } : {}),
        ...(optional !== undefined ? { optional } : {}),
      };
    }
    case "oidc_client": {
      exactKeys(record, field, ["kind", "variables", "callbackPath", "scopes"]);
      const variables = variablesValue(record.variables, `${field}.variables`, [
        "issuerUrl",
        "accountsUrl",
        "clientId",
        "redirectUri",
      ]);
      const callbackPath = stringValue(
        record.callbackPath,
        `${field}.callbackPath`,
        256,
      );
      if (!callbackPath.startsWith("/")) {
        throw invalid(`${field}.callbackPath must start with /`);
      }
      const scopes = has(record, "scopes")
        ? stringArray(record.scopes, `${field}.scopes`, 128)
        : undefined;
      return {
        kind: "oidc_client",
        variables,
        callbackPath,
        ...(scopes ? { scopes } : {}),
      };
    }
    case "artifact":
      exactKeys(record, field, ["kind", "variables"]);
      return {
        kind: "artifact",
        variables: variablesValue(record.variables, `${field}.variables`, [
          "url",
          "sha256",
        ]),
      };
    default:
      throw invalid(`${field}.kind is unsupported`);
  }
}

function variablesValue<const K extends string>(
  value: unknown,
  field: string,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const record = objectValue(value, field);
  exactKeys(record, field, keys);
  const output: Partial<Record<K, string>> = {};
  for (const key of keys) {
    if (has(record, key)) {
      output[key] = variableNameValue(record[key], `${field}.${key}`);
    }
  }
  return output;
}

function outputAllowlistValue(
  value: unknown,
): Readonly<Record<string, OutputAllowlistEntry>> {
  const record = objectValue(value, "outputAllowlist");
  const output: Record<string, OutputAllowlistEntry> = {};
  for (const [name, item] of Object.entries(record)) {
    variableNameValue(name, `outputAllowlist key ${name}`);
    const field = `outputAllowlist.${name}`;
    const entry = objectValue(item, field);
    exactKeys(entry, field, ["from", "type", "required", "sensitive"]);
    const type = enumValue(entry.type, `${field}.type`, [
      "string",
      "url",
      "hostname",
      "number",
      "boolean",
      "json",
    ] as const);
    const required = optionalBoolean(entry, "required", field);
    const sensitive = optionalBoolean(entry, "sensitive", field);
    output[name] = {
      from: variableNameValue(entry.from, `${field}.from`),
      type,
      ...(required !== undefined ? { required } : {}),
      ...(sensitive !== undefined ? { sensitive } : {}),
    };
  }
  return output;
}

function interfaceBlueprintsValue(
  value: unknown,
): readonly CapsuleInterfaceBlueprint[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw invalid(
      "interfaceBlueprints must be an array with at most 64 entries",
    );
  }
  for (const [index, blueprint] of value.entries()) {
    if (!isJsonValue(blueprint)) {
      throw invalid(`interfaceBlueprints[${index}] must be JSON`);
    }
  }
  return value as unknown as readonly CapsuleInterfaceBlueprint[];
}

function lifecycleActionsValue(
  value: unknown,
): readonly InstallConfigLifecycleAction[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw invalid("lifecycleActions must be an array with at most 20 entries");
  }
  return value.map((item, index) => {
    const field = `lifecycleActions[${index}]`;
    const record = objectValue(item, field);
    exactKeys(record, field, [
      "apiVersion",
      "kind",
      "id",
      "phase",
      "executor",
      "command",
      "workingDirectory",
      "env",
      "timeoutSeconds",
      "runnerCapability",
      "useProviderCredentials",
    ]);
    if (
      record.apiVersion !== "takosumi.dev/v1alpha1" ||
      record.kind !== "command"
    ) {
      throw invalid(`${field} has an unsupported action version or kind`);
    }
    const workingDirectory = has(record, "workingDirectory")
      ? stringValue(record.workingDirectory, `${field}.workingDirectory`, 1024)
      : undefined;
    const env = has(record, "env")
      ? stringRecord(record.env, `${field}.env`)
      : undefined;
    const timeoutSeconds = has(record, "timeoutSeconds")
      ? integerValue(record.timeoutSeconds, `${field}.timeoutSeconds`)
      : undefined;
    const useProviderCredentials = optionalBoolean(
      record,
      "useProviderCredentials",
      field,
    );
    return {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: stringValue(record.id, `${field}.id`, 128),
      phase: enumValue(record.phase, `${field}.phase`, [
        "post_apply",
        "pre_destroy",
      ] as const),
      executor: enumValue(record.executor, `${field}.executor`, [
        "runner",
        "operator",
      ] as const),
      command: stringArray(record.command, `${field}.command`, 4096),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(env ? { env } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      runnerCapability: tokenValue(
        record.runnerCapability,
        `${field}.runnerCapability`,
        128,
        /^[a-z0-9][a-z0-9._/-]*$/u,
      ),
      ...(useProviderCredentials !== undefined
        ? { useProviderCredentials }
        : {}),
    };
  });
}

type LifecycleActionPolicy = NonNullable<PolicyConfig["lifecycleActions"]>;

function lifecycleActionPolicyValue(value: unknown): LifecycleActionPolicy {
  const record = objectValue(value, "lifecycleActionPolicy");
  exactKeys(record, "lifecycleActionPolicy", [
    "allowedExecutors",
    "allowedRunnerCapabilities",
    "allowProviderCredentials",
  ]);
  const allowedExecutors = enumArray(
    record.allowedExecutors,
    "lifecycleActionPolicy.allowedExecutors",
    ["runner", "operator"] as const,
  );
  const allowedRunnerCapabilities = stringArray(
    record.allowedRunnerCapabilities,
    "lifecycleActionPolicy.allowedRunnerCapabilities",
    128,
  );
  const allowProviderCredentials = optionalBoolean(
    record,
    "allowProviderCredentials",
    "lifecycleActionPolicy",
  );
  return {
    allowedExecutors,
    allowedRunnerCapabilities,
    ...(allowProviderCredentials !== undefined
      ? { allowProviderCredentials }
      : {}),
  };
}

function localizedTextValue(
  value: unknown,
  field: string,
): { readonly ja: string; readonly en: string } {
  const record = objectValue(value, field);
  exactKeys(record, field, ["ja", "en"]);
  return {
    ja: stringValue(record.ja, `${field}.ja`, 500),
    en: stringValue(record.en, `${field}.en`, 500),
  };
}

function jsonRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, JsonValue>> {
  const record = objectValue(value, field);
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!isJsonValue(item)) throw invalid(`${field}.${key} must be JSON`);
    output[key] = item;
  }
  return output;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const record = objectValue(value, field);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    output[key] = stringValue(item, `${field}.${key}`, 4096);
  }
  return output;
}

function stringArray(
  value: unknown,
  field: string,
  maxStringLength: number,
): readonly string[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  return value.map((item, index) =>
    stringValue(item, `${field}[${index}]`, maxStringLength),
  );
}

function enumArray<const T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
): readonly T[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  return value.map((item, index) =>
    enumValue(item, `${field}[${index}]`, choices),
  );
}

function variableNameValue(value: unknown, field: string): string {
  return tokenValue(value, field, 128, VARIABLE_NAME);
}

function optionalToken(
  record: Record<string, unknown>,
  key: string,
  field: string,
  maxLength: number,
): string | undefined {
  return has(record, key)
    ? tokenValue(record[key], `${field}.${key}`, maxLength, TOKEN)
    : undefined;
}

function tokenValue(
  value: unknown,
  field: string,
  maxLength: number,
  pattern: RegExp,
): string {
  const output = stringValue(value, field, maxLength);
  if (!pattern.test(output)) throw invalid(`${field} has an unsupported shape`);
  return output;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  field: string,
): boolean | undefined {
  if (!has(record, key)) return undefined;
  if (typeof record[key] !== "boolean") {
    throw invalid(`${field}.${key} must be a boolean`);
  }
  return record[key];
}

function optionalEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  field: string,
  choices: readonly T[],
): T | undefined {
  return has(record, key)
    ? enumValue(record[key], `${field}.${key}`, choices)
    : undefined;
}

function enumValue<const T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw invalid(`${field} is unsupported`);
  }
  return value as T;
}

function integerValue(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw invalid(`${field} must be an integer`);
  return value as number;
}

function stringValue(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw invalid(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!set.has(key)) throw invalid(`${field} contains unknown field ${key}`);
  }
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function invalid(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError("invalid_argument", message);
}
