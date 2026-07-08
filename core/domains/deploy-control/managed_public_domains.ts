import type { InstallConfig } from "@takosumi/internal/deploy-control-api";
import { installExperiencePublicEndpoint } from "takosumi-contract";

export const DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN = "app.takos.jp";

export type PublicHostPolicyKind = "managed_default_hostname" | "custom_domain";

export function managedPublicBaseDomainFromInstallConfig(
  installConfig: InstallConfig | undefined,
): string {
  return (
    normalizeManagedPublicBaseDomain(
      installExperiencePublicEndpoint(installConfig?.store?.installExperience)
        ?.baseDomain,
    ) ?? DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN
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
  baseDomain = DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN,
): string | undefined {
  const label = typeof value === "string" ? value.trim() : "";
  if (!isManagedPublicHostLabel(label)) return undefined;
  const normalizedBase =
    normalizeManagedPublicBaseDomain(baseDomain) ??
    DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN;
  return `${label}.${normalizedBase}`;
}

export function isManagedPublicHost(
  host: string,
  baseDomain = DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN,
): boolean {
  const normalizedBase =
    normalizeManagedPublicBaseDomain(baseDomain) ??
    DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN;
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
  baseDomains: readonly string[] = [DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN],
): PublicHostPolicyKind {
  return baseDomains.some((baseDomain) => isManagedPublicHost(host, baseDomain))
    ? "managed_default_hostname"
    : "custom_domain";
}

export function normalizeManagedPublicBaseDomains(
  values: readonly string[] | undefined,
): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const domain = normalizeManagedPublicBaseDomain(value);
    if (domain) normalized.add(domain);
  }
  return normalized.size > 0
    ? [...normalized]
    : [DEFAULT_MANAGED_PUBLIC_BASE_DOMAIN];
}

function isManagedPublicHostLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}
