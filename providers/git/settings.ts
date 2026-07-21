import type { ConnectionScopeHints } from "takosumi-contract/connections";

/** Provider-owned, non-secret settings for Git source credential drivers. */
export interface GitProviderSettings {
  readonly repositoryUrl?: string;
  readonly username?: string;
  readonly knownHostsEntry?: string;
}

export function gitProviderSettings(
  scopeHints: ConnectionScopeHints | undefined,
): GitProviderSettings {
  const settings = scopeHints?.providerSettings;
  return {
    ...(stringSetting(settings?.repositoryUrl)
      ? { repositoryUrl: stringSetting(settings?.repositoryUrl) }
      : {}),
    ...(stringSetting(settings?.username)
      ? { username: stringSetting(settings?.username) }
      : {}),
    ...(stringSetting(settings?.knownHostsEntry)
      ? { knownHostsEntry: stringSetting(settings?.knownHostsEntry) }
      : {}),
  };
}

/**
 * Normalized `host[:port]` a Git source credential is bound to, parsed from an
 * http(s) URL. The HTTPS askpass script answers ANY host's credential prompt,
 * so a connection may only ever be minted for the host it declares: without
 * that binding a Source pointed at an attacker-controlled host would make the
 * runner hand the stored PAT to that host.
 */
export function gitHostScope(url: string | undefined): string | undefined {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  return parsed.host.toLowerCase();
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
