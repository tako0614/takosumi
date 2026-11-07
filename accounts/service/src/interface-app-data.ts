import { isInterfaceAppDataAuthority, type InterfaceAppDataAuthority } from "takosumi-contract/interfaces";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";
import { validateOidcLiveGrant } from "./oidc-live-grant.ts";

interface SourcePrincipal {
  readonly accountSubject: string;
  readonly clientId: string;
  readonly scope: string;
}

async function currentSource(input: {
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly consumerCapsuleId: string;
  readonly principal: SourcePrincipal;
}) {
  if (!input.operations || !input.principal.accountSubject || !input.principal.clientId || !input.principal.scope) return undefined;
  if (!(await input.store.findAccount(input.principal.accountSubject as TakosumiSubject))) return undefined;
  const client = await input.store.findOidcClient(input.principal.clientId);
  if (!client || client.capsuleId !== input.consumerCapsuleId || client.namespacePath !== "identity.oidc" ||
    client.subjectMode !== "pairwise") return undefined;
  const grant = await validateOidcLiveGrant({ store: input.store, operations: input.operations, client,
    scope: input.principal.scope, takosumiSubject: input.principal.accountSubject as TakosumiSubject,
    capsuleId: input.consumerCapsuleId });
  return grant.ok && grant.capsuleId === input.consumerCapsuleId &&
    (grant.appRole === "owner" || grant.appRole === "member") ? grant : undefined;
}

/** Trusted host port: binds the exact persisted bearer to its current app client and member. */
export async function resolveInterfaceAppDataPrincipal(input: {
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly token: string;
  readonly consumerCapsuleId: string;
  readonly subjectId: string;
}): Promise<SourcePrincipal | undefined> {
  try {
    const record = await input.store.findAccessToken(input.token);
    if (!record || record.expiresAt <= Date.now() || record.role === "runtime" || record.role === "interface-runtime" ||
      !record.takosumiSubject || record.subject !== input.subjectId || record.capsuleId !== input.consumerCapsuleId) return undefined;
    const principal = { accountSubject: record.takosumiSubject, clientId: record.clientId, scope: record.scope };
    return await currentSource({ ...input, principal }) ? principal : undefined;
  } catch { return undefined; }
}

/** Combined with Core's live Binding/link/AppAccess check, not a substitute for it. */
export async function validateInterfaceAppDataSource(input: {
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly authority: InterfaceAppDataAuthority;
  readonly accountSubject?: string;
  readonly client?: { readonly clientId: string; readonly scope: string };
}): Promise<boolean> {
  try {
    if (!isInterfaceAppDataAuthority(input.authority) || !input.accountSubject || !input.client) return false;
    const grant = await currentSource({ ...input, consumerCapsuleId: input.authority.consumer_capsule_id,
      principal: { accountSubject: input.accountSubject, ...input.client } });
    return grant?.appRole === input.authority.app_role;
  } catch { return false; }
}
