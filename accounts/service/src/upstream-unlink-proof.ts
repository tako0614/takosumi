import type { AccountsStore, UpstreamLoginTransactionRecord } from "./store.ts";
import type { CredentialUnlinkReceipt, UnlinkOperationProofContext } from "./identity-unlink-state.ts";
import type { UpstreamOAuthOptions } from "./mod.ts";
import type { UpstreamAuthorizationCodeExchangeResult } from "./upstream.ts";
import { buildUpstreamAuthorizationUrl } from "./upstream.ts";
import { assertSocialLoginScopes, assertVerifiedSocialProvider } from "./upstream-verification.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";
import { hostedIssuerSessionId } from "./hosted-oidc-profile.ts";
import { upstreamIdentityKey } from "./identity-state.ts";
import {
  CREDENTIAL_UNLINK_TTL_MS,
  assertCredentialUnlinkIntentCurrent,
  readCredentialUnlinkBrowserBindingHash,
  readCredentialUnlinkBrowserSession,
  readCredentialUnlinkJson,
} from "./identity-unlink.ts";
import { json, withOAuthNoStoreHeaders } from "./http-helpers.ts";

const beginPattern = /^\/api\/v1\/account\/identity-credentials\/unlink-intents\/(iunl_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/upstream-proof\/begin$/u;

export function isUpstreamUnlinkProofBeginPath(path: string): boolean {
  return beginPattern.test(path);
}

/** Explicit retained-credential consent mints a new operation-bound OAuth transaction. */
export async function handleUpstreamUnlinkProofBeginRequest(input: {
  request: Request;
  store: AccountsStore;
  upstreamOAuth: UpstreamOAuthOptions;
  issuerOrigin: string;
  secureCookie: boolean;
  now?: number;
}): Promise<Response | undefined> {
  const url = new URL(input.request.url);
  const match = beginPattern.exec(url.pathname);
  if (!match) return undefined;
  const fail = (error: string, status: number) => withOAuthNoStoreHeaders(json({ error }, status));
  if (input.request.method !== "POST") return fail("method_not_allowed", 405);
  const issuer = new URL(input.issuerOrigin);
  if (!input.secureCookie || issuer.protocol !== "https:" || issuer.origin !== url.origin || input.request.headers.get("origin") !== issuer.origin) return fail("invalid_origin", 403);
  if (url.search) return fail("invalid_request", 400);
  const body = await readCredentialUnlinkJson(input.request);
  if (!body || Object.keys(body).length !== 1 || body.consent !== true) return fail("invalid_request", 400);
  const now = input.now ?? Date.now();
  const session = await readCredentialUnlinkBrowserSession(input.store, input.request, now);
  const browserBindingHash = await readCredentialUnlinkBrowserBindingHash(input.request);
  if (!session || !browserBindingHash) return fail("authentication_required", 401);
  try {
    const intent = await input.store.findCredentialUnlinkIntent?.(match[1]!);
    if (!intent || intent.subject !== session.subject || intent.browserBindingHash !== browserBindingHash ||
      !input.store.saveUpstreamLoginTransaction || !input.store.createCredentialUnlinkReceipt) return fail("proof_unavailable", 409);
    await assertCredentialUnlinkIntentCurrent(input.store, intent, now);
    const issuerSessionHash = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
    if (issuerSessionHash !== intent.issuerSessionHash) return fail("proof_unavailable", 409);
    const registrations = input.upstreamOAuth.providers.filter((provider) => provider.providerId === intent.retainedIdentity.providerId);
    const registration = registrations[0];
    if (registrations.length !== 1 || !registration || !input.upstreamOAuth.hostedSessionPolicy) return fail("proof_unavailable", 503);
    assertVerifiedSocialProvider(registration.provider);
    assertSocialLoginScopes(registration.provider, registration.scopes ?? registration.provider.defaultScopes);
    if (registration.provider.issuer !== intent.retainedIdentity.upstreamIssuer) return fail("proof_unavailable", 409);
    const redirect = new URL(registration.redirectUri);
    if (redirect.origin !== issuer.origin || redirect.username || redirect.password || redirect.hash) return fail("proof_unavailable", 503);
    const state = randomHex();
    const binding = randomHex();
    const codeVerifier = base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(32)));
    const context: UnlinkOperationProofContext = {
      receiptId: `iupr_${crypto.randomUUID()}`,
      operationId: intent.operationId,
      subject: intent.subject,
      removedIdentity: { ...intent.removedIdentity },
      retainedIdentity: { ...intent.retainedIdentity },
      browserBindingHash,
      issuerSessionHash,
      identityGeneration: intent.identityGeneration,
      policyVersion: intent.policyVersion,
      transactionDigest: "",
      startedAt: now,
      expiresAt: Math.min(intent.expiresAt, now + CREDENTIAL_UNLINK_TTL_MS),
      legConsent: true,
      legConsentAt: now,
    };
    context.transactionDigest = await transactionDigest(state, context);
    const transaction: UpstreamLoginTransactionRecord = {
      id: state,
      providerId: registration.providerId,
      browserBindingHash: await sha256Text(binding),
      codeVerifier,
      nonce: randomHex(),
      redirectUri: registration.redirectUri,
      createdAt: now,
      expiresAt: context.expiresAt,
      unlinkProof: context,
    };
    await input.store.saveUpstreamLoginTransaction(transaction);
    const location = buildUpstreamAuthorizationUrl({
      provider: registration.provider,
      clientId: registration.clientId,
      redirectUri: registration.redirectUri,
      state,
      codeChallenge: (await sha256Text(codeVerifier)).slice(7),
      codeChallengeMethod: "S256",
      nonce: registration.provider.verificationProfile === "google-oidc" ? transaction.nonce : undefined,
      scopes: registration.scopes,
    });
    return withOAuthNoStoreHeaders(json({ authorization_url: location.toString(), unlink_intent_id: intent.operationId }, 200, {
      "set-cookie": `__Host-takosumi_upstream=${encodeURIComponent(`${registration.providerId}:${state}:${binding}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((transaction.expiresAt - now) / 1000))}`,
    }));
  } catch { return fail("proof_unavailable", 409); }
}

/** The owning callback first verifies provider code, signature/nonce and immutable identity. */
export async function validateUpstreamUnlinkProof(input: {
  request: Request;
  store: AccountsStore;
  transaction: UpstreamLoginTransactionRecord;
  exchange: UpstreamAuthorizationCodeExchangeResult;
  now: number;
}): Promise<void> {
  const context = input.transaction.unlinkProof;
  if (!context) return;
  if (input.transaction.operationProof) throw new TypeError("ambiguous operation proof");
  const intent = await input.store.findCredentialUnlinkIntent?.(context.operationId);
  const session = await readCredentialUnlinkBrowserSession(input.store, input.request, input.now);
  const browserBindingHash = await readCredentialUnlinkBrowserBindingHash(input.request);
  if (!intent || !session || !browserBindingHash) throw new TypeError("unlink proof is unavailable");
  await assertCredentialUnlinkIntentCurrent(input.store, intent, input.now);
  const anchor = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
  if (context.operationId !== intent.operationId || context.subject !== intent.subject || session.subject !== intent.subject ||
    upstreamIdentityKey(context.removedIdentity) !== upstreamIdentityKey(intent.removedIdentity) ||
    upstreamIdentityKey(context.retainedIdentity) !== upstreamIdentityKey(intent.retainedIdentity) ||
    context.browserBindingHash !== intent.browserBindingHash || context.browserBindingHash !== browserBindingHash ||
    context.issuerSessionHash !== intent.issuerSessionHash || context.issuerSessionHash !== anchor ||
    context.identityGeneration !== intent.identityGeneration || context.policyVersion !== intent.policyVersion ||
    context.legConsent !== true || context.legConsentAt !== context.startedAt ||
    context.startedAt !== input.transaction.createdAt || context.startedAt < intent.createdAt || context.startedAt > input.now ||
    context.expiresAt !== input.transaction.expiresAt || context.expiresAt > intent.expiresAt || context.expiresAt <= input.now ||
    context.expiresAt > context.startedAt + CREDENTIAL_UNLINK_TTL_MS ||
    context.transactionDigest !== await transactionDigest(input.transaction.id, context) ||
    input.transaction.providerId !== intent.retainedIdentity.providerId ||
    upstreamIdentityKey(input.exchange) !== upstreamIdentityKey(intent.retainedIdentity)) {
    throw new TypeError("invalid retained identity proof");
  }
}

export async function completeUpstreamUnlinkProof(input: {
  request: Request;
  store: AccountsStore;
  transaction: UpstreamLoginTransactionRecord;
  exchange: UpstreamAuthorizationCodeExchangeResult;
  now: number;
}): Promise<CredentialUnlinkReceipt | undefined> {
  const context = input.transaction.unlinkProof;
  if (!context) return undefined;
  await validateUpstreamUnlinkProof(input);
  if (!input.store.createCredentialUnlinkReceipt) throw new TypeError("unlink receipt store is unavailable");
  const receipt: CredentialUnlinkReceipt = { ...context, method: "upstream-oauth-operation", completedAt: input.now };
  if (!await input.store.createCredentialUnlinkReceipt(receipt)) throw new TypeError("unlink receipt was already recorded");
  return receipt;
}

async function transactionDigest(state: string, context: UnlinkOperationProofContext): Promise<string> {
  return await sha256Text(JSON.stringify(["upstream-oauth-unlink@v1", state, context.receiptId, context.operationId,
    context.subject, upstreamIdentityKey(context.removedIdentity), upstreamIdentityKey(context.retainedIdentity),
    context.browserBindingHash, context.issuerSessionHash, context.identityGeneration, context.policyVersion,
    context.startedAt, context.expiresAt, context.legConsent, context.legConsentAt]));
}

function randomHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
