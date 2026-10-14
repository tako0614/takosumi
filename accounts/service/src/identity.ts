import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

import { verifyPasskeyAssertion } from "./passkey.ts";
import type {
  AccountsStore,
  AccountEmailProofRecord,
  PasskeyCredentialRecord,
  TakosumiAccountRecord,
} from "./store.ts";
import { deriveTakosumiSubject } from "./subject.ts";
import { normalizeMergeEmail } from "./identity-state.ts";

export interface AccountProfileInput {
  email?: string;
  displayName?: string;
  picture?: string;
  /**
   * The upstream identity provider's `email_verified` assertion, when the
   * provider returned one. `undefined` means the provider did not assert
   * verification (genuinely unknown); we never coerce unknown to `true`.
   */
  emailVerified?: boolean;
  /** Exact fresh provider observation, distinct from the legacy scalar. */
  emailProof?: Omit<AccountEmailProofRecord, "subject" | "normalizedAddress">;
}

export interface ResolveUpstreamAccountInput {
  store: AccountsStore;
  subjectSecret: string | Uint8Array | CryptoKey;
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  profile?: AccountProfileInput;
  hostedPolicy?: boolean;
  now?: number;
}

export interface RegisterPasskeyCredentialInput {
  store: AccountsStore;
  subject: TakosumiSubject;
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  signCount?: number;
  transports?: readonly string[];
  now?: number;
}

export interface AuthenticatePasskeyInput {
  store: AccountsStore;
  credentialId: string;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  now?: number;
}

export interface AuthenticatePasskeyResult {
  account: TakosumiAccountRecord;
  credential: PasskeyCredentialRecord;
}

export async function resolveUpstreamAccount(
  input: ResolveUpstreamAccountInput,
): Promise<TakosumiAccountRecord> {
  const now = input.now ?? Date.now();
  const identity = {
    providerId: input.providerId,
    upstreamIssuer: input.upstreamIssuer,
    upstreamSubject: input.upstreamSubject,
  };
  if (input.hostedPolicy) {
    if (!input.store.findCanonicalAccount || !input.store.isAccountAuthenticationFenced || !input.store.findUpstreamIdentityStatus || !input.store.linkUpstreamIdentityIfAbsent) {
      throw new TypeError("shared account identity store is unavailable");
    }
    const status = await input.store.findUpstreamIdentityStatus(identity);
    if (status?.disabledAt !== undefined) throw new TypeError("upstream identity is disabled");
  }
  const linked = await input.store.findUpstreamIdentity({
    providerId: input.providerId,
    upstreamIssuer: input.upstreamIssuer,
    upstreamSubject: input.upstreamSubject,
  });
  const boundSubject =
    linked?.subject ??
    (await deriveTakosumiSubject({
      secret: input.subjectSecret,
      upstreamIssuer: input.upstreamIssuer,
      upstreamSubject: input.upstreamSubject,
    }));
  const boundAccount = await input.store.findAccount(boundSubject);
  const canonical = input.hostedPolicy && boundAccount
    ? await input.store.findCanonicalAccount!(boundSubject)
    : undefined;
  if (input.hostedPolicy && boundAccount && !canonical) {
    throw new TypeError("canonical account mapping is unavailable");
  }
  const subject = canonical?.subject ?? boundSubject;
  if (input.hostedPolicy && (await input.store.isAccountAuthenticationFenced!(boundSubject) ||
    await input.store.isAccountAuthenticationFenced!(subject))) {
    throw new TypeError("account authentication is fenced");
  }
  const existing = canonical ?? boundAccount;
  // Verification belongs to this exact address observation. Keeping a contact
  // address when omitted never preserves a previous provider's verification.
  const email = input.profile?.email ?? existing?.email;
  const emailVerified = input.profile?.email !== undefined
    ? input.profile.emailVerified
    : undefined;
  const account: TakosumiAccountRecord = {
    ...existing,
    subject,
    email,
    displayName: input.profile?.displayName ?? existing?.displayName,
    picture: input.profile?.picture ?? existing?.picture,
    emailVerified,
    createdAt: existing?.createdAt ?? linked?.createdAt ?? now,
    updatedAt: now,
  };

  await input.store.saveAccount(account);
  const binding = {
    ...identity,
    subject: linked?.subject ?? subject,
    createdAt: linked?.createdAt ?? now,
    updatedAt: now,
  };
  if (input.hostedPolicy) {
    const created = await input.store.linkUpstreamIdentityIfAbsent!(binding);
    if (!created && (await input.store.findUpstreamIdentity(identity))?.subject !== binding.subject) {
      throw new TypeError("immutable upstream identity binding conflict");
    }
  } else {
    await input.store.linkUpstreamIdentity(binding);
  }

  const proof = input.profile?.emailProof;
  const normalizedAddress = proof ? normalizeMergeEmail(proof.address) : undefined;
  if (proof && normalizedAddress && proof.address === email && emailVerified === true &&
    proof.providerId === input.providerId && proof.upstreamIssuer === input.upstreamIssuer &&
    proof.upstreamSubject === input.upstreamSubject && proof.observedAt <= now &&
    proof.observedAt >= now - 5 * 60_000 && proof.validUntil > now &&
    proof.validUntil <= proof.observedAt + 5 * 60_000) {
    if (input.hostedPolicy && !input.store.saveAccountEmailProof) {
      throw new TypeError("email proof store is unavailable");
    }
    await input.store.saveAccountEmailProof?.({ ...proof, subject, normalizedAddress });
  }

  // Keep the OAuth identity resolver side-effect free. The canonical first page
  // of GET /api/v1/workspaces owns the awaited, idempotent personal-Workspace
  // ensure because that route already has the deploy-control facade. Identity
  // reads such as session/me remain read-only and safe for internal auth probes.

  return account;
}

export async function registerPasskeyCredential(
  input: RegisterPasskeyCredentialInput,
): Promise<PasskeyCredentialRecord> {
  const account = await input.store.findAccount(input.subject);
  if (!account) {
    throw new TypeError("passkey credential subject does not exist");
  }

  const now = input.now ?? Date.now();
  const existing = await input.store.findPasskeyCredential(input.credentialId);
  if (existing && existing.subject !== input.subject) {
    throw new TypeError(
      "passkey credential already belongs to another account",
    );
  }

  const credential: PasskeyCredentialRecord = {
    credentialId: input.credentialId,
    subject: input.subject,
    publicKeyJwk: input.publicKeyJwk,
    signCount: input.signCount ?? existing?.signCount ?? 0,
    transports: input.transports ?? existing?.transports,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await input.store.savePasskeyCredential(credential);
  return credential;
}

export async function authenticatePasskey(
  input: AuthenticatePasskeyInput,
): Promise<AuthenticatePasskeyResult> {
  const credential = await input.store.findPasskeyCredential(
    input.credentialId,
  );
  if (!credential) {
    throw new TypeError("passkey credential is not registered");
  }

  const verification = await verifyPasskeyAssertion({
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    rpId: input.rpId,
    publicKeyJwk: credential.publicKeyJwk,
    authenticatorData: input.authenticatorData,
    clientDataJSON: input.clientDataJSON,
    signature: input.signature,
  });
  // Per Agent 6 item 5: always compare against the stored signCount, never
  // short-circuit on `stored === 0`. The stored value starts at 0 on
  // initial registration; an honest authenticator increments on every
  // assertion, so the first auth must yield signCount > stored OR keep
  // signCount === 0 (resident keys that never increment WebAuthn §6.1.1).
  // Equal sign counts are only acceptable when both sides are zero (the
  // explicit "this authenticator does not maintain a counter" sentinel).
  if (verification.signCount === 0 && credential.signCount === 0) {
    // Allowed: WebAuthn-compliant non-counting authenticator.
  } else if (verification.signCount <= credential.signCount) {
    throw new TypeError("passkey authenticator sign count did not increase");
  }

  const account = await input.store.findAccount(credential.subject);
  if (!account) {
    throw new TypeError("passkey account does not exist");
  }

  const updatedCredential: PasskeyCredentialRecord = {
    ...credential,
    signCount: verification.signCount,
    updatedAt: input.now ?? Date.now(),
  };
  await input.store.savePasskeyCredential(updatedCredential);

  return {
    account,
    credential: updatedCredential,
  };
}
