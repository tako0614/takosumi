import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

import { verifyPasskeyAssertion } from "./passkey.ts";
import type {
  AccountsStore,
  PasskeyCredentialRecord,
  TakosumiAccountRecord,
} from "./store.ts";
import { deriveTakosumiSubject } from "./subject.ts";

export interface AccountProfileInput {
  email?: string;
  displayName?: string;
  /**
   * The upstream identity provider's `email_verified` assertion, when the
   * provider returned one. `undefined` means the provider did not assert
   * verification (genuinely unknown); we never coerce unknown to `true`.
   */
  emailVerified?: boolean;
}

export interface ResolveUpstreamAccountInput {
  store: AccountsStore;
  subjectSecret: string | Uint8Array | CryptoKey;
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  profile?: AccountProfileInput;
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
  const linked = await input.store.findUpstreamIdentity({
    providerId: input.providerId,
    upstreamIssuer: input.upstreamIssuer,
    upstreamSubject: input.upstreamSubject,
  });
  const subject = linked?.subject ?? await deriveTakosumiSubject({
    secret: input.subjectSecret,
    upstreamIssuer: input.upstreamIssuer,
    upstreamSubject: input.upstreamSubject,
  });
  const existing = await input.store.findAccount(subject);
  // `emailVerified` is now a first-class field on `TakosumiAccountRecord` and
  // is persisted end to end (Postgres column, D1/in-memory document). We
  // persist the upstream assertion when present and otherwise preserve the
  // previously stored value rather than coercing unknown to a fixed boolean.
  const account: TakosumiAccountRecord = {
    subject,
    email: input.profile?.email ?? existing?.email,
    displayName: input.profile?.displayName ?? existing?.displayName,
    emailVerified: input.profile?.emailVerified ?? existing?.emailVerified,
    createdAt: existing?.createdAt ?? linked?.createdAt ?? now,
    updatedAt: now,
  };

  await input.store.saveAccount(account);
  await input.store.linkUpstreamIdentity({
    providerId: input.providerId,
    upstreamIssuer: input.upstreamIssuer,
    upstreamSubject: input.upstreamSubject,
    subject,
    createdAt: linked?.createdAt ?? now,
    updatedAt: now,
  });

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
