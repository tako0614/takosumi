import type { AccountsStore, TokenRecord } from "./store.ts";

/**
 * Resolves an unexpired access token. Capsule-scoped runtime and Interface
 * OAuth tokens remain active only while their short lifetime and Interface
 * evidence are valid. Capsule lifecycle authority stays in canonical core.
 */
export async function findActiveAccessToken(input: {
  readonly store: AccountsStore;
  readonly token: string;
  readonly now?: number;
}): Promise<TokenRecord | undefined> {
  const record = await input.store.findAccessToken(input.token);
  const now = input.now ?? Date.now();
  const interfaceRuntime = record?.role === "interface-runtime";
  const interfaceEvidenceComplete =
    !interfaceRuntime ||
    (nonEmpty(record.audience) &&
      nonEmpty(record.workspaceId) &&
      nonEmpty(record.interfaceId) &&
      nonEmpty(record.interfaceBindingId) &&
      typeof record.interfaceResolvedRevision === "number" &&
      Number.isSafeInteger(record.interfaceResolvedRevision) &&
      record.interfaceResolvedRevision > 0);
  const active =
    record !== undefined &&
    record.expiresAt > now &&
    interfaceEvidenceComplete &&
    record.role !== "runtime";
  if (active) return record;
  if (record) await input.store.deleteToken(input.token);
  return undefined;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
