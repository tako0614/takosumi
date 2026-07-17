import type { AccountsStore, TokenRecord } from "./store.ts";

export interface InterfaceOAuthActivityEvidence {
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly interfaceId: string;
  readonly bindingId: string;
  readonly interfaceResolvedRevision: number;
  readonly subjectId: string;
  readonly permission: string;
  readonly resource: string;
}

/** Host port from Accounts token storage back to canonical Interface Core. */
export type InterfaceOAuthActivityValidator = (
  evidence: InterfaceOAuthActivityEvidence,
) => boolean | Promise<boolean>;

/**
 * Resolves an unexpired access token. Capsule-scoped runtime and Interface
 * OAuth tokens remain active only while their short lifetime and Interface
 * evidence are valid. Capsule lifecycle authority stays in canonical core.
 */
export async function findActiveAccessToken(input: {
  readonly store: AccountsStore;
  readonly token: string;
  readonly now?: number;
  readonly interfaceOAuthActivityValidator?: InterfaceOAuthActivityValidator;
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
  let interfaceEvidenceCurrent = !interfaceRuntime;
  if (
    interfaceRuntime &&
    interfaceEvidenceComplete &&
    input.interfaceOAuthActivityValidator
  ) {
    try {
      interfaceEvidenceCurrent =
        (await input.interfaceOAuthActivityValidator({
          workspaceId: record!.workspaceId!,
          ...(record!.capsuleId ? { capsuleId: record!.capsuleId } : {}),
          interfaceId: record!.interfaceId!,
          bindingId: record!.interfaceBindingId!,
          interfaceResolvedRevision: record!.interfaceResolvedRevision!,
          subjectId: record!.subject,
          permission: record!.scope,
          resource: record!.audience!,
        })) === true;
    } catch {
      interfaceEvidenceCurrent = false;
    }
  }
  const active =
    record !== undefined &&
    record.expiresAt > now &&
    interfaceEvidenceComplete &&
    interfaceEvidenceCurrent &&
    record.role !== "runtime";
  if (active) return record;
  if (record) await input.store.deleteToken(input.token);
  return undefined;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
