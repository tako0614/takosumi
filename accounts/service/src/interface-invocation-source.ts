import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { isInterfaceOAuthRole, isInterfaceInvocationSource, type InterfaceInvocationSource } from "../../../contract/internal-interface-invocation-source.ts";
import type { AccountsStore, TokenRecord } from "./store.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";
import { validateOidcLiveGrant } from "./oidc-live-grant.ts";

/** Captured only from the exact Request's successful Accounts bearer authentication. */
export interface AuthenticatedInvocationSource {
  readonly kind: "oauth-access-token";
  readonly tokenHash: string;
  readonly accountSubject: string;
  readonly subjectId: string;
  readonly clientId: string;
  readonly capsuleId: string;
}

function ordinary(record: TokenRecord | undefined): record is TokenRecord {
  return !!record && record.role !== "runtime" && !isInterfaceOAuthRole(record.role) &&
    record.oidcProfile === undefined && record.appDataAuthority === undefined && record.appDataClient === undefined && record.invocationSource === undefined;
}

function sameParent(record: TokenRecord | undefined, source: InterfaceInvocationSource, now: number): boolean {
  return ordinary(record) && record.expiresAt > now && record.expiresAt === source.expiresAt &&
    record.takosumiSubject === source.accountSubject && record.subject === source.subjectId &&
    record.clientId === source.clientId && record.capsuleId === source.capsuleId && record.scope === source.scope &&
    record.workspaceId === source.workspaceId && record.role === source.role;
}

/** Existing OIDC grant policy plus hash reads; never guess a bearer for deletion. */
export async function validateInterfaceInvocationSource(input: {
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly source: InterfaceInvocationSource;
  readonly now?: number;
}): Promise<boolean> {
  // Caller objects must not change across asynchronous authority reads.
  try {
    const source = structuredClone(input.source);
    const now = () => input.now ?? Date.now();
    if (!isInterfaceInvocationSource(source) || !input.operations || !input.store.findAccessTokenByHash ||
      !input.store.findCanonicalAccount || !input.store.isAccountAuthenticationFenced) return false;
    const before = await input.store.findAccessTokenByHash(source.tokenHash);
    if (!sameParent(before, source, now())) return false;
    if ((await input.store.findCanonicalAccount(source.accountSubject as TakosumiSubject))?.subject !== source.accountSubject ||
      await input.store.isAccountAuthenticationFenced(source.accountSubject as TakosumiSubject)) return false;
    const client = await input.store.findOidcClient(source.clientId);
    if (!client || client.capsuleId !== source.capsuleId || client.namespacePath !== "identity.oidc" ||
      client.subjectMode !== "pairwise" || client.activationDigest !== source.activationDigest) return false;
    const grant = await validateOidcLiveGrant({ store: input.store, operations: input.operations, client,
      scope: source.scope, takosumiSubject: source.accountSubject as TakosumiSubject,
      capsuleId: source.capsuleId, ...(before!.workspaceId ? { workspaceId: before!.workspaceId } : {}) });
    if (!grant.ok || grant.capsuleId !== source.capsuleId) return false;
    const currentClient = await input.store.findOidcClient(source.clientId);
    if (!currentClient || JSON.stringify(currentClient) !== JSON.stringify(client)) return false;
    if (!sameParent(await input.store.findAccessTokenByHash(source.tokenHash), source, now())) return false;
    return (await input.store.findCanonicalAccount(source.accountSubject as TakosumiSubject))?.subject === source.accountSubject &&
      !(await input.store.isAccountAuthenticationFenced(source.accountSubject as TakosumiSubject));
  } catch { return false; }
}

/** No M2 evidence is inferred from a legacy token, public claims, or raw account IDs. */
export async function captureInterfaceInvocationSource(input: {
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly authenticated: AuthenticatedInvocationSource;
}): Promise<InterfaceInvocationSource | undefined> {
  try {
    const authenticated = structuredClone(input.authenticated);
    if (authenticated.kind !== "oauth-access-token" || !input.store.findAccessTokenByHash) return undefined;
    const record = await input.store.findAccessTokenByHash(authenticated.tokenHash);
    if (!ordinary(record) || record.takosumiSubject !== authenticated.accountSubject ||
      record.subject !== authenticated.subjectId || record.clientId !== authenticated.clientId ||
      record.capsuleId !== authenticated.capsuleId) return undefined;
    const client = await input.store.findOidcClient(record.clientId);
    if (!client?.activationDigest) return undefined;
    const source: InterfaceInvocationSource = { version: "takosumi.interface-invocation-source/v1",
      kind: "oauth-access-token", tokenHash: authenticated.tokenHash, accountSubject: authenticated.accountSubject,
      subjectId: record.subject, clientId: record.clientId, capsuleId: authenticated.capsuleId,
      scope: record.scope, expiresAt: record.expiresAt, activationDigest: client.activationDigest,
      ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
      ...(record.role !== undefined ? { role: record.role } : {}) };
    return await validateInterfaceInvocationSource({ ...input, source }) ? source : undefined;
  } catch { return undefined; }
}
