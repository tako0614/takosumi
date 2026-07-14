import type { ConnectionScopeHints } from "takosumi-contract/connections";

/** Provider-owned, non-secret settings for the AWS AssumeRole recipe. */
export interface AwsProviderSettings {
  readonly roleArn?: string;
  readonly externalId?: string;
  readonly region?: string;
}

export function awsProviderSettings(
  scopeHints: ConnectionScopeHints | undefined,
): AwsProviderSettings {
  const settings = scopeHints?.providerSettings;
  return {
    ...(stringSetting(settings?.roleArn)
      ? { roleArn: stringSetting(settings?.roleArn) }
      : {}),
    ...(stringSetting(settings?.externalId)
      ? { externalId: stringSetting(settings?.externalId) }
      : {}),
    ...(stringSetting(settings?.region)
      ? { region: stringSetting(settings?.region) }
      : {}),
  };
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
