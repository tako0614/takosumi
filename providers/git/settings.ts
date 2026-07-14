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

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
