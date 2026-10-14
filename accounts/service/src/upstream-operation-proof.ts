import type { AccountsStore, AccountSessionRecord, UpstreamLoginTransactionRecord } from "./store.ts";
import type { IdentityOperationReceiptRecord } from "./identity-state.ts";
import type { UpstreamOAuthOptions } from "./mod.ts";
import type { UpstreamAuthorizationCodeExchangeResult } from "./upstream.ts";
import { buildUpstreamAuthorizationUrl } from "./upstream.ts";
import { assertSocialLoginScopes, assertVerifiedSocialProvider } from "./upstream-verification.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";
import { hostedIssuerSessionId } from "./hosted-oidc-profile.ts";
import { identityMergeAddressDigest, readIdentityMergeBrowserBindingHash } from "./identity-merge.ts";
import { normalizeMergeEmail } from "./identity-state.ts";
import { json, readJsonObject, withOAuthNoStoreHeaders } from "./http-helpers.ts";

const beginPattern = /^\/api\/v1\/account\/identity-merges\/(imrg_[a-f0-9-]{36})\/upstream-proof\/begin$/u;
const proofTtlMs = 5 * 60_000;

export function isUpstreamOperationProofBeginPath(path: string): boolean {
  return beginPattern.test(path);
}

/** The browser approves one named operation leg before any upstream redirect. */
export async function handleUpstreamOperationProofBeginRequest(input: {
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
  if (!input.secureCookie || issuer.protocol !== "https:" || url.origin !== issuer.origin ||
    input.request.headers.get("origin") !== issuer.origin) return fail("invalid_origin", 403);
  if (url.search || input.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return fail("invalid_request", 400);
  }
  try {
    const body = await readJsonObject(input.request);
    if (!body || Object.keys(body).some((key) => !["role", "providerId", "consent"].includes(key)) ||
      (body.role !== "source" && body.role !== "target") || typeof body.providerId !== "string" || body.consent !== true) {
      return fail("invalid_request", 400);
    }
    const now = input.now ?? Date.now();
    const browserBindingHash = await readIdentityMergeBrowserBindingHash(input.request);
    const session = await readProofBrowserSession(input.store, input.request, now);
    const operation = await input.store.findIdentityMergeOperation?.(match[1]!);
    if (!browserBindingHash || !session || !operation || operation.browserBindingHash !== browserBindingHash ||
      ![operation.sourceSubject, operation.targetSubject].includes(session.subject)) return fail("proof_unavailable", 403);
    if ((operation.status !== "pending" && operation.status !== "proved") || operation.consentAt !== undefined ||
      operation.expiresAt <= now || operation.createdAt > now || operation.expiresAt - operation.createdAt > proofTtlMs ||
      operation[body.role === "source" ? "sourceProof" : "targetProof"] ||
      !input.store.listCanonicalUpstreamIdentities || !input.store.getAccountAuthenticationGeneration ||
      !input.store.saveUpstreamLoginTransaction || !input.store.createIdentityOperationReceipt ||
      !input.store.isHostedOidcSessionHashRevoked) return fail("proof_unavailable", 409);
    const subject = body.role === "source" ? operation.sourceSubject : operation.targetSubject;
    const identities = await input.store.listCanonicalUpstreamIdentities(subject);
    if (identities.length > 100) return fail("proof_unavailable", 409);
    const selected = identities.filter((identity) => identity.providerId === body.providerId);
    if (selected.length !== 1) return fail("proof_unavailable", 409);
    const identity = selected[0]!;
    const canonical = await input.store.findCanonicalAccount?.(identity.subject);
    const status = await input.store.findUpstreamIdentityStatus?.(identity);
    if (canonical?.subject !== subject || status?.disabledAt !== undefined || await input.store.isAccountAuthenticationFenced?.(subject)) {
      return fail("proof_unavailable", 409);
    }
    const registration = input.upstreamOAuth.providers.find((provider) => provider.providerId === identity.providerId);
    if (!registration || !input.upstreamOAuth.hostedSessionPolicy) return fail("proof_unavailable", 503);
    assertVerifiedSocialProvider(registration.provider);
    assertSocialLoginScopes(registration.provider, registration.scopes ?? registration.provider.defaultScopes);
    if (registration.provider.issuer !== identity.upstreamIssuer) return fail("proof_unavailable", 409);
    const redirect = new URL(registration.redirectUri);
    if (redirect.origin !== issuer.origin || redirect.username || redirect.password || redirect.hash) return fail("proof_unavailable", 503);
    const issuerSessionHash = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
    if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(issuerSessionHash) || await input.store.isHostedOidcSessionHashRevoked(issuerSessionHash)) return fail("proof_unavailable", 409);
    const state = randomHex();
    const binding = randomHex();
    const codeVerifier = base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = randomHex();
    const transactionDigest = await sha256Text(JSON.stringify(["upstream-oauth-operation@v1", state, operation.operationId,
      body.role, operation.sourceSubject, operation.targetSubject, identity.providerId, identity.upstreamIssuer,
      identity.upstreamSubject, subject, browserBindingHash, operation.policyVersion, now]));
    const transaction: UpstreamLoginTransactionRecord = {
      id: state,
      providerId: identity.providerId,
      browserBindingHash: await sha256Text(binding),
      codeVerifier,
      nonce,
      redirectUri: registration.redirectUri,
      createdAt: now,
      expiresAt: Math.min(now + proofTtlMs, operation.expiresAt),
      operationProof: {
        receiptId: `iopr_${crypto.randomUUID()}`,
        operationId: operation.operationId,
        role: body.role,
        sourceSubject: operation.sourceSubject,
        targetSubject: operation.targetSubject,
        subject,
        providerId: identity.providerId,
        upstreamIssuer: identity.upstreamIssuer,
        upstreamSubject: identity.upstreamSubject,
        browserBindingHash,
        policyVersion: operation.policyVersion,
        identityGeneration: await input.store.getAccountAuthenticationGeneration(subject),
        transactionDigest,
        startedAt: now,
        expiresAt: Math.min(now + proofTtlMs, operation.expiresAt),
        legConsent: true,
        legConsentAt: now,
        issuerSessionHash,
      },
    };
    await input.store.saveUpstreamLoginTransaction(transaction);
    const location = buildUpstreamAuthorizationUrl({
      provider: registration.provider,
      clientId: registration.clientId,
      redirectUri: registration.redirectUri,
      state,
      codeChallenge: (await sha256Text(codeVerifier)).slice(7),
      codeChallengeMethod: "S256",
      nonce: registration.provider.verificationProfile === "google-oidc" ? nonce : undefined,
      scopes: registration.scopes,
    });
    return withOAuthNoStoreHeaders(json({
      authorization_url: location.toString(),
      operation_id: operation.operationId,
      role: body.role,
    }, 200, {
      "set-cookie": `__Host-takosumi_upstream=${encodeURIComponent(`${identity.providerId}:${state}:${binding}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((transaction.expiresAt - now) / 1000))}`,
    }));
  } catch {
    return fail("proof_unavailable", 409);
  }
}

/** Validate operation context before resolving/updating any account profile. */
export async function validateUpstreamOperationProof(input: {
  request: Request;
  store: AccountsStore;
  transaction: UpstreamLoginTransactionRecord;
  exchange: UpstreamAuthorizationCodeExchangeResult;
  now: number;
}): Promise<void> {
  const context = input.transaction.operationProof;
  if (!context) return;
  const operation = await input.store.findIdentityMergeOperation?.(context.operationId);
  const browserBindingHash = await readIdentityMergeBrowserBindingHash(input.request);
  const session = await readProofBrowserSession(input.store, input.request, input.now);
  const expectedDigest = await sha256Text(JSON.stringify(["upstream-oauth-operation@v1", input.transaction.id, context.operationId,
    context.role, context.sourceSubject, context.targetSubject, context.providerId, context.upstreamIssuer,
    context.upstreamSubject, context.subject, context.browserBindingHash, context.policyVersion, context.startedAt]));
  if (!operation || !session || !browserBindingHash || context.transactionDigest !== expectedDigest ||
    (context.role !== "source" && context.role !== "target") || browserBindingHash !== context.browserBindingHash ||
    operation.browserBindingHash !== context.browserBindingHash || operation.sourceSubject !== context.sourceSubject ||
    operation.targetSubject !== context.targetSubject || operation.policyVersion !== context.policyVersion ||
    (operation.status !== "pending" && operation.status !== "proved") || operation.consentAt !== undefined ||
    operation.expiresAt <= input.now || context.expiresAt <= input.now || context.expiresAt !== input.transaction.expiresAt ||
    context.expiresAt > operation.expiresAt || context.startedAt < operation.createdAt ||
    context.startedAt !== input.transaction.createdAt || context.legConsent !== true || context.legConsentAt !== context.startedAt ||
    context.startedAt > input.now || input.now - context.startedAt > proofTtlMs ||
    context.subject !== (context.role === "source" ? operation.sourceSubject : operation.targetSubject) ||
    ![operation.sourceSubject, operation.targetSubject].includes(session.subject) ||
    input.exchange.providerId !== context.providerId || input.exchange.upstreamIssuer !== context.upstreamIssuer ||
    input.exchange.upstreamSubject !== context.upstreamSubject) throw new TypeError("invalid operation proof context");
  const issuerSessionHash = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(issuerSessionHash) || issuerSessionHash !== context.issuerSessionHash || !input.store.isHostedOidcSessionHashRevoked ||
    await input.store.isHostedOidcSessionHashRevoked(context.issuerSessionHash) ||
    !input.store.getAccountAuthenticationGeneration ||
    await input.store.getAccountAuthenticationGeneration(context.subject) !== context.identityGeneration ||
    await input.store.isAccountAuthenticationFenced?.(context.subject)) throw new TypeError("operation proof is fenced");
  const identity = await input.store.findUpstreamIdentity(context);
  const status = await input.store.findUpstreamIdentityStatus?.(context);
  const canonical = identity ? await input.store.findCanonicalAccount?.(identity.subject) : undefined;
  if (!identity || canonical?.subject !== context.subject || status?.disabledAt !== undefined) throw new TypeError("operation identity changed");
  const proof = input.exchange.profile?.emailProof;
  const normalizedAddress = proof ? normalizeMergeEmail(proof.address) : undefined;
  if (!proof || !normalizedAddress || input.exchange.profile?.emailVerified !== true || input.exchange.profile.email !== proof.address ||
    proof.providerId !== context.providerId || proof.upstreamIssuer !== context.upstreamIssuer || proof.upstreamSubject !== context.upstreamSubject ||
    !Number.isSafeInteger(proof.observedAt) || !Number.isSafeInteger(proof.validUntil) || proof.validUntil > proof.observedAt + proofTtlMs ||
    proof.observedAt < context.startedAt ||
    proof.observedAt > input.now || proof.validUntil <= input.now ||
    (!proof.authoritative && proof.verification !== "mailbox") ||
    await identityMergeAddressDigest(normalizedAddress) !== operation.addressDigest) {
    throw new TypeError("fresh operation address proof is required");
  }
}

export async function completeUpstreamOperationProof(input: {
  request: Request;
  store: AccountsStore;
  transaction: UpstreamLoginTransactionRecord;
  exchange: UpstreamAuthorizationCodeExchangeResult;
  now: number;
}): Promise<IdentityOperationReceiptRecord | undefined> {
  const context = input.transaction.operationProof;
  if (!context) return undefined;
  await validateUpstreamOperationProof(input);
  const operation = await input.store.findIdentityMergeOperation!(context.operationId);
  if (!operation || !input.store.createIdentityOperationReceipt) throw new TypeError("operation receipt store is unavailable");
  const receipt: IdentityOperationReceiptRecord = {
    ...context,
    method: "upstream-oauth-operation",
    completedAt: input.now,
    emailDigest: operation.addressDigest,
  };
  if (!(await input.store.createIdentityOperationReceipt(receipt))) throw new TypeError("operation receipt was already recorded");
  return receipt;
}

async function readProofBrowserSession(store: AccountsStore, request: Request, now: number): Promise<AccountSessionRecord | undefined> {
  const entries = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith("__Host-takosumi_session="));
  if (entries.length !== 1) return undefined;
  const raw = entries[0]!.slice("__Host-takosumi_session=".length);
  if (!/^sess_h_[A-Za-z0-9_-]{43}$/u.test(raw)) return undefined;
  const session = await store.findAccountSession(raw);
  if (!session || session.policy !== "hosted" || session.expiresAt <= now || !session.absoluteExpiresAt || session.absoluteExpiresAt <= now ||
    !store.getAccountAuthenticationGeneration || session.identityGeneration !== await store.getAccountAuthenticationGeneration(session.subject) ||
    !(await store.findAccount(session.subject)) || await store.isAccountAuthenticationFenced?.(session.subject)) return undefined;
  return session;
}

function randomHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
