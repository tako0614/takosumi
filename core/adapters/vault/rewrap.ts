import type { ConnectionVault, SecretRewrapResult } from "./mod.ts";

/** Operator-invoked batch. Callers supply reviewed connection IDs; no secret data is returned. */
export async function rewrapVaultSecrets(
  vault: Pick<ConnectionVault, "rewrapConnectionSecret">,
  connectionIds: readonly string[],
  options: { readonly dryRun?: boolean } = {},
): Promise<readonly SecretRewrapResult[]> {
  const results: SecretRewrapResult[] = [];
  for (const connectionId of new Set(connectionIds)) {
    results.push(await vault.rewrapConnectionSecret(connectionId, options));
  }
  return results;
}
