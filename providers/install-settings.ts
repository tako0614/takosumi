/** Reference provider-owned public settings proposals for an explicit user choice. */
import type { JsonValue, ProviderConnection } from "takosumi-contract";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { cloudflareInstallSettings } from "./cloudflare/settings.ts";

export function providerInstallSettings(
  connection: ProviderConnection,
): Readonly<Record<string, JsonValue>> | undefined {
  if (connection.status !== "verified") return undefined;
  if (sameProviderSource(connection.providerSource, "registry.opentofu.org/cloudflare/cloudflare")) {
    return cloudflareInstallSettings(connection);
  }
  return undefined;
}
