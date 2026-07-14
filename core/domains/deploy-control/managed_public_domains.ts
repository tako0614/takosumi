import type { InstallConfig } from "@takosumi/internal/deploy-control-api";
import type { ManagedPublicHostnameMode } from "takosumi-contract/install-configs";
import { installExperiencePublicEndpoint } from "takosumi-contract";

export type PublicHostPolicyKind = "managed_default_hostname" | "custom_domain";

export function managedPublicHostnameMode(
  installConfig: InstallConfig | undefined,
): ManagedPublicHostnameMode {
  return installConfig?.managedPublicHostname?.mode === "vanity"
    ? "vanity"
    : "scoped";
}

export function managedPublicBaseDomainFromInstallConfig(
  installConfig: InstallConfig | undefined,
): string | undefined {
  return normalizeManagedPublicBaseDomain(
    installExperiencePublicEndpoint(installConfig?.installExperience)
      ?.baseDomain,
  );
}

export function normalizeManagedPublicBaseDomain(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\*\./u, "")
    .replace(/\.$/u, "");
  if (!normalized || normalized.includes("://")) return undefined;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
    normalized,
  )
    ? normalized
    : undefined;
}

export function managedPublicHostFromLabel(
  value: unknown,
  baseDomain: string,
): string | undefined {
  const label = typeof value === "string" ? value.trim() : "";
  if (!isManagedPublicHostLabel(label)) return undefined;
  const normalizedBase = normalizeManagedPublicBaseDomain(baseDomain);
  if (!normalizedBase) return undefined;
  return `${label}.${normalizedBase}`;
}

/**
 * Builds the shared managed-host label for one Workspace. The caller supplies
 * an arbitrary app slug; the globally unique Workspace handle is always the
 * namespace prefix. Passing an already-prefixed label is idempotent so retries
 * and edits do not grow the hostname.
 */
export function managedPublicLabelForWorkspace(
  workspaceHandle: unknown,
  requestedSlug: unknown,
): string | undefined {
  const workspace = normalizeManagedPublicLabel(workspaceHandle);
  const requested = normalizeManagedPublicLabel(requestedSlug);
  if (!workspace || !requested) return undefined;
  const label = requested.startsWith(`${workspace}-`)
    ? requested
    : `${workspace}-${requested}`;
  return isManagedPublicHostLabel(label) ? label : undefined;
}

export function normalizeManagedPublicHostLabel(
  value: unknown,
): string | undefined {
  return normalizeManagedPublicLabel(value);
}

export function managedPublicHostForWorkspace(
  workspaceHandle: unknown,
  requestedSlug: unknown,
  baseDomain: string,
): string | undefined {
  const label = managedPublicLabelForWorkspace(workspaceHandle, requestedSlug);
  return label ? managedPublicHostFromLabel(label, baseDomain) : undefined;
}

export function isManagedPublicHost(
  host: string,
  baseDomain: string,
): boolean {
  const normalizedBase = normalizeManagedPublicBaseDomain(baseDomain);
  if (!normalizedBase) return false;
  const normalizedHost = host.toLowerCase();
  if (!normalizedHost.endsWith(`.${normalizedBase}`)) return false;
  const label = normalizedHost.slice(
    0,
    normalizedHost.length - normalizedBase.length - 1,
  );
  return isManagedPublicHostLabel(label);
}

export function publicHostPolicyKind(
  host: string,
  baseDomains: readonly string[] = [],
): PublicHostPolicyKind {
  return baseDomains.some((baseDomain) => isManagedPublicHost(host, baseDomain))
    ? "managed_default_hostname"
    : "custom_domain";
}

export function normalizeManagedPublicBaseDomains(
  values: readonly unknown[] | undefined,
): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const domain = normalizeManagedPublicBaseDomain(value);
    if (domain) normalized.add(domain);
  }
  return [...normalized];
}

function isManagedPublicHostLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function normalizeManagedPublicLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isManagedPublicHostLabel(normalized) ? normalized : undefined;
}
