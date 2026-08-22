import type { AccountsStore } from "@takosjp/takosumi-accounts-service";

export type CapsulePublicOidcRetirementStore = Pick<
  AccountsStore,
  "findOidcClientForCapsule" | "revokeOidcClient"
>;

/**
 * Retires the exact current public OIDC client for one Capsule and confirms
 * absence from Accounts before returning. A lost delete acknowledgement is
 * adopted only when the authoritative readback proves the client is gone.
 */
export async function retireCapsulePublicOidcIdentity(input: {
  readonly store: CapsulePublicOidcRetirementStore;
  readonly capsuleId: string;
  readonly expectedClientId?: string;
}): Promise<void> {
  const capsuleId = requiredCapsuleId(input.capsuleId);
  const current = await input.store.findOidcClientForCapsule(capsuleId);
  if (!current) return;
  if (
    input.expectedClientId !== undefined &&
    current.clientId !== input.expectedClientId
  ) {
    throw new Error(
      "Capsule public OIDC client changed before revocation; refusing stale destroy",
    );
  }

  try {
    await input.store.revokeOidcClient(current.clientId);
  } catch (error) {
    if (!(await input.store.findOidcClientForCapsule(capsuleId))) return;
    throw error;
  }
  if (await input.store.findOidcClientForCapsule(capsuleId)) {
    throw new Error(
      "Capsule retained its public OIDC client after revocation",
    );
  }
}

function requiredCapsuleId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Capsule id is invalid");
  }
  return value;
}
