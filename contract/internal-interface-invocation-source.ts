/** Persisted discriminator prevents missing evidence from becoming a legacy invocation. */
export const INTERFACE_INVOCATION_SOURCE_ROLE = "interface-runtime-source-v1";
export function isInterfaceOAuthRole(role: unknown): boolean {
  return role === "interface-runtime" || role === INTERFACE_INVOCATION_SOURCE_ROLE;
}

/** Private issuer evidence. This DTO does not authenticate a caller or authorize chaining. */
export interface InterfaceInvocationSource {
  readonly version: "takosumi.interface-invocation-source/v1";
  readonly kind: "oauth-access-token";
  /** Existing Accounts access-token hash, never the bearer value. */
  readonly tokenHash: string;
  readonly accountSubject: string;
  readonly subjectId: string;
  readonly clientId: string;
  readonly capsuleId: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly activationDigest: string;
  readonly workspaceId?: string;
  readonly role?: string;
}

export interface InterfaceInvocationProvenance {
  readonly source: InterfaceInvocationSource;
  readonly interfaceGeneration: number;
  readonly bindingGeneration: number;
  readonly link?: { readonly id: string; readonly generation: number };
}

export function isInterfaceInvocationSource(value: unknown): value is InterfaceInvocationSource {
  if (!record(value) || !exact(value, ["version", "kind", "tokenHash", "accountSubject", "subjectId", "clientId",
    "capsuleId", "scope", "expiresAt", "activationDigest", ...(value.workspaceId === undefined ? [] : ["workspaceId"]),
    ...(value.role === undefined ? [] : ["role"])])) return false;
  return value.version === "takosumi.interface-invocation-source/v1" && value.kind === "oauth-access-token" &&
    typeof value.tokenHash === "string" && /^sha256:[A-Za-z0-9_-]{43}$/u.test(value.tokenHash) &&
    ["accountSubject", "subjectId", "clientId", "capsuleId", "activationDigest"].every(k => text(value[k], 512)) &&
    text(value.scope, 2048) && integer(value.expiresAt) &&
    (value.workspaceId === undefined || text(value.workspaceId, 512)) && (value.role === undefined || text(value.role, 512));
}

export function isInterfaceInvocationProvenance(value: unknown): value is InterfaceInvocationProvenance {
  if (!record(value) || !exact(value, ["source", "interfaceGeneration", "bindingGeneration",
    ...(value.link === undefined ? [] : ["link"])])) return false;
  return isInterfaceInvocationSource(value.source) && integer(value.interfaceGeneration) && integer(value.bindingGeneration) &&
    (value.link === undefined || (record(value.link) && exact(value.link, ["id", "generation"]) &&
      text(value.link.id, 512) && integer(value.link.generation)));
}

/** Shared persistence invariant; legacy records without M2 evidence are unchanged. */
export function assertInterfaceInvocationAccessRecord(value: {
  readonly invocationSource?: unknown; readonly role?: string; readonly oidcProfile?: unknown;
  readonly appDataAuthority?: unknown; readonly appDataClient?: unknown; readonly subject: string;
  readonly takosumiSubject?: string; readonly expiresAt: number;
}, access: boolean): void {
  if (value.invocationSource === undefined && value.role !== INTERFACE_INVOCATION_SOURCE_ROLE) return;
  const proof = value.invocationSource;
  if (!access || value.role !== INTERFACE_INVOCATION_SOURCE_ROLE || value.oidcProfile !== undefined ||
    value.appDataAuthority !== undefined || value.appDataClient !== undefined || !isInterfaceInvocationProvenance(proof) ||
    value.subject !== proof.source.subjectId || value.takosumiSubject !== undefined ||
    !integer(value.expiresAt) || value.expiresAt > proof.source.expiresAt) {
    throw new TypeError("Invocation provenance requires complete access-token evidence");
  }
}

/** Detach new private records before a store's first asynchronous hash/write. */
export function prepareInterfaceInvocationAccessRecord<T extends Parameters<typeof assertInterfaceInvocationAccessRecord>[0]>(value: T, access: boolean): T {
  if (value.invocationSource === undefined && value.role !== INTERFACE_INVOCATION_SOURCE_ROLE) return value;
  const snapshot = structuredClone(value);
  assertInterfaceInvocationAccessRecord(snapshot, access);
  return snapshot;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, max: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function integer(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
