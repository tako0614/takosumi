import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { derivePairwiseSubject } from "../../accounts/service/src/subject.ts";
import type {
  AccountsStore,
  OidcClientRecord,
} from "../../accounts/service/src/store.ts";

export type CapsuleOidcAccountsLedger = Pick<
  AccountsStore,
  "findOidcClient" | "findOidcClientForCapsule" | "saveOidcClient"
>;

export interface RegisterCapsulePublicOidcClientInput {
  readonly accounts: CapsuleOidcAccountsLedger;
  readonly capsule: { readonly id: string; readonly name: string };
  readonly installingPrincipalId: TakosumiSubject;
  readonly issuer: string;
  readonly publicOrigin: string;
  readonly callbackPath: string;
  readonly scopes: readonly string[];
  readonly clientId: string;
  readonly pairwiseSubjectSecret: string;
  readonly clock: () => Date;
}

export type ValidateCapsulePublicOidcClientRegistrationInput = Omit<
  RegisterCapsulePublicOidcClientInput,
  "clock"
>;

export type DeriveCapsulePublicOidcClientIdentityInput = Pick<
  RegisterCapsulePublicOidcClientInput,
  | "capsule"
  | "installingPrincipalId"
  | "publicOrigin"
  | "callbackPath"
  | "clientId"
  | "pairwiseSubjectSecret"
>;

export interface CapsulePublicOidcClientIdentity {
  readonly clientId: string;
  readonly ownerSubject: TakosumiSubject;
  readonly redirectUri: string;
}

export interface CapsulePublicOidcClientRegistrationValidation {
  readonly identity: CapsulePublicOidcClientIdentity;
  readonly existing?: OidcClientRecord;
}

/** Pure deterministic identity derivation shared by Plan and Apply. */
export async function deriveCapsulePublicOidcClientIdentity(
  input: DeriveCapsulePublicOidcClientIdentityInput,
): Promise<CapsulePublicOidcClientIdentity> {
  const redirectUri = new URL(input.callbackPath, `${input.publicOrigin}/`).href;
  const ownerSubject = await derivePairwiseSubject({
    secret: input.pairwiseSubjectSecret,
    takosumiSubject: input.installingPrincipalId,
    clientId: `${input.capsule.name}:${input.capsule.id}:${input.clientId}`,
  });
  return { clientId: input.clientId, ownerSubject, redirectUri };
}

/**
 * Read-only collision and immutable-metadata validation shared by Plan and
 * Apply. Existing public clients are authority, not rows Apply may silently
 * rewrite after a Plan was reviewed.
 */
export async function validateCapsulePublicOidcClientRegistration(
  input: ValidateCapsulePublicOidcClientRegistrationInput,
): Promise<CapsulePublicOidcClientRegistrationValidation> {
  const identity = await deriveCapsulePublicOidcClientIdentity(input);
  const [existingForCapsule, existingForClient] = await Promise.all([
    input.accounts.findOidcClientForCapsule(input.capsule.id),
    input.accounts.findOidcClient(input.clientId),
  ]);
  if (existingForCapsule && existingForCapsule.clientId !== input.clientId) {
    throw new TypeError("Capsule is already bound to another OIDC client");
  }
  if (existingForClient && existingForClient.capsuleId !== input.capsule.id) {
    throw new TypeError("OIDC client is already bound to another Capsule");
  }
  if (Boolean(existingForCapsule) !== Boolean(existingForClient)) {
    throw new TypeError("current Accounts OIDC client indexes drifted");
  }
  if (
    existingForCapsule &&
    !samePublicClient(existingForCapsule, input, identity)
  ) {
    throw new TypeError(
      "current Accounts OIDC client metadata drift is not allowed",
    );
  }
  if (
    existingForClient &&
    !samePublicClient(existingForClient, input, identity)
  ) {
    throw new TypeError(
      "current Accounts OIDC client metadata drift is not allowed",
    );
  }
  return {
    identity,
    ...(existingForClient ? { existing: existingForClient } : {}),
  };
}

/** Shared idempotent Accounts registration used by both host materializers. */
export async function registerCapsulePublicOidcClient(
  input: RegisterCapsulePublicOidcClientInput,
): Promise<CapsulePublicOidcClientIdentity> {
  const { identity, existing } =
    await validateCapsulePublicOidcClientRegistration(input);
  if (existing) return identity;
  const now = input.clock().getTime();
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new TypeError("clock is invalid");
  }
  const registration: OidcClientRecord = {
    clientId: input.clientId,
    capsuleId: input.capsule.id,
    namespacePath: "identity.oidc",
    issuerUrl: input.issuer,
    redirectUris: [identity.redirectUri],
    allowedScopes: input.scopes,
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: now,
    updatedAt: now,
  };
  await input.accounts.saveOidcClient(registration);
  return identity;
}

function samePublicClient(
  current: OidcClientRecord,
  input: ValidateCapsulePublicOidcClientRegistrationInput,
  identity: CapsulePublicOidcClientIdentity,
): boolean {
  return (
    current.clientId === input.clientId &&
    current.capsuleId === input.capsule.id &&
    current.namespacePath === "identity.oidc" &&
    current.issuerUrl === input.issuer &&
    sameStrings(current.redirectUris, [identity.redirectUri]) &&
    sameStrings(current.allowedScopes, input.scopes) &&
    current.subjectMode === "pairwise" &&
    current.tokenEndpointAuthMethod === "none" &&
    current.clientSecretHash === undefined
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function derivePublicOidcClientId(
  secret: string,
  parts: readonly string[],
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(parts.join("\n"))),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `tko_${btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}
