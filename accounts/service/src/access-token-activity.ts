import type { AccountsStore, TokenRecord } from "./store.ts";

export interface InterfaceOAuthActivityEvidence {
  /**
   * Compatibility evidence (TASK-0118 Phase 9): a token of a Capsule-owned
   * Interface is identified by `capsuleId` alone; Core still compares a
   * Workspace when the token carries one.
   */
  readonly workspaceId?: string;
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
  readonly assertActive?: () => void;
}): Promise<TokenRecord | undefined> {
  input.assertActive?.();
  const record = await input.store.findAccessToken(input.token);
  input.assertActive?.();
  return await validateActiveAccessTokenRecord({ ...input, record });
}

/** Apply the shared activity policy to an already-resolved exact token row. */
export async function validateActiveAccessTokenRecord(input: {
  readonly store: AccountsStore;
  readonly token: string;
  readonly record: TokenRecord | undefined;
  readonly now?: number;
  readonly interfaceOAuthActivityValidator?: InterfaceOAuthActivityValidator;
  readonly assertActive?: () => void;
}): Promise<TokenRecord | undefined> {
  input.assertActive?.();
  const { record } = input;
  const now = input.now ?? Date.now();
  const interfaceRuntime = record?.role === "interface-runtime";
  // The Interface owner is named by its Capsule, or by its Workspace for a
  // Workspace-owned Interface. Either one completes the evidence; Core then
  // checks it against the live Interface and Binding.
  const interfaceEvidenceComplete =
    !interfaceRuntime ||
    (nonEmpty(record.audience) &&
      (nonEmpty(record.workspaceId) || nonEmpty(record.capsuleId)) &&
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
          ...(nonEmpty(record!.workspaceId) ? { workspaceId: record!.workspaceId! } : {}),
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
    input.assertActive?.();
  }
  const active =
    record !== undefined &&
    record.expiresAt > now &&
    interfaceEvidenceComplete &&
    interfaceEvidenceCurrent &&
    record.role !== "runtime";
  if (active) return record;
  if (record) {
    input.assertActive?.();
    await input.store.deleteToken(input.token);
    input.assertActive?.();
  }
  return undefined;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
