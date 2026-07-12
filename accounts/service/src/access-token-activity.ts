import type { AccountsStore, TokenRecord } from "./store.ts";

/**
 * Resolves an access token only while its owning Capsule remains active.
 * Runtime service tokens must not outlive a failed, suspended, or exported
 * Capsule projection, and malformed runtime records fail closed.
 */
export async function findActiveAccessToken(input: {
  readonly store: AccountsStore;
  readonly token: string;
  readonly now?: number;
}): Promise<TokenRecord | undefined> {
  const record = await input.store.findAccessToken(input.token);
  const now = input.now ?? Date.now();
  const requiresReadyCapsule = record?.role === "runtime";
  const runtimeCapsuleId = requiresReadyCapsule
    ? record.capsuleId
    : undefined;
  const capsule = runtimeCapsuleId
    ? await input.store.findAppCapsule(runtimeCapsuleId)
    : undefined;
  const active =
    record !== undefined &&
    record.expiresAt >= now &&
    (!requiresReadyCapsule ||
      (runtimeCapsuleId !== undefined && capsule?.status === "ready"));
  if (active) return record;
  if (record) await input.store.deleteToken(input.token);
  return undefined;
}
