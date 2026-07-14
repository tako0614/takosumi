import type { JsonValue } from "takosumi-contract";
import type { ConnectionScopeHints } from "takosumi-contract/connections";

export interface CloudflareTokenVendingConfig {
  readonly policies: readonly CloudflareTokenPolicy[];
  readonly ttlSeconds?: number;
  readonly namePrefix?: string;
  readonly condition?: Readonly<Record<string, JsonValue>>;
}

export interface CloudflareTokenPolicy {
  readonly id?: string;
  readonly effect: "allow" | "deny";
  readonly permission_groups: readonly CloudflarePermissionGroup[];
  readonly resources: Readonly<Record<string, JsonValue>>;
}

export interface CloudflarePermissionGroup {
  readonly id: string;
  readonly meta?: Readonly<Record<string, string>>;
  readonly name?: string;
}

export interface CloudflareProviderSettings {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly workersSubdomain?: string;
  readonly tokenVending?: CloudflareTokenVendingConfig;
}

/** Decode only inside the provider package; Core persists this as opaque JSON. */
export function cloudflareProviderSettings(
  scopeHints: ConnectionScopeHints | undefined,
): CloudflareProviderSettings {
  const settings = scopeHints?.providerSettings;
  return {
    ...(stringSetting(settings?.accountId)
      ? { accountId: stringSetting(settings?.accountId) }
      : {}),
    ...(stringSetting(settings?.zoneId)
      ? { zoneId: stringSetting(settings?.zoneId) }
      : {}),
    ...(stringSetting(settings?.workersSubdomain)
      ? { workersSubdomain: stringSetting(settings?.workersSubdomain) }
      : {}),
    ...(tokenVendingSetting(settings?.tokenVending)
      ? { tokenVending: tokenVendingSetting(settings?.tokenVending) }
      : {}),
  };
}

function tokenVendingSetting(
  value: unknown,
): CloudflareTokenVendingConfig | undefined {
  if (!isRecord(value) || !Array.isArray(value.policies)) return undefined;
  const policies = value.policies
    .map(tokenPolicy)
    .filter((policy): policy is CloudflareTokenPolicy => policy !== undefined);
  if (policies.length !== value.policies.length) return undefined;
  const ttlSeconds = value.ttlSeconds;
  const namePrefix = stringSetting(value.namePrefix);
  const condition = isJsonRecord(value.condition) ? value.condition : undefined;
  return {
    policies,
    ...(ttlSeconds === undefined
      ? {}
      : { ttlSeconds: numberSetting(ttlSeconds) }),
    ...(namePrefix ? { namePrefix } : {}),
    ...(condition ? { condition } : {}),
  };
}

function tokenPolicy(value: unknown): CloudflareTokenPolicy | undefined {
  if (
    !isRecord(value) ||
    (value.effect !== "allow" && value.effect !== "deny")
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.permission_groups) ||
    !isJsonRecord(value.resources)
  ) {
    return undefined;
  }
  const permissionGroups = value.permission_groups
    .map(permissionGroup)
    .filter((group): group is CloudflarePermissionGroup => group !== undefined);
  if (permissionGroups.length !== value.permission_groups.length)
    return undefined;
  return {
    ...(stringSetting(value.id) ? { id: stringSetting(value.id) } : {}),
    effect: value.effect,
    permission_groups: permissionGroups,
    resources: value.resources,
  };
}

function permissionGroup(
  value: unknown,
): CloudflarePermissionGroup | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringSetting(value.id);
  if (!id) return undefined;
  const meta = isStringRecord(value.meta) ? value.meta : undefined;
  return {
    id,
    ...(meta ? { meta } : {}),
    ...(stringSetting(value.name) ? { name: stringSetting(value.name) } : {}),
  };
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
