import type { AccountsStore, AccountSessionRecord } from "./store.ts";
import type {
  CredentialIdentityTuple,
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkReconciler,
} from "./identity-unlink-state.ts";
import { hostedIssuerSessionId, HOSTED_SESSION_ABSOLUTE_MS } from "./hosted-oidc-profile.ts";
import { upstreamIdentityKey } from "./identity-state.ts";
import { sha256Text } from "./encoding.ts";
import { json, withOAuthNoStoreHeaders } from "./http-helpers.ts";

const inventoryPath = "/api/v1/account/identity-credentials";
const basePath = `${inventoryPath}/unlink-intents`;
const operationPattern = /^iunl_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const browserCookie = "__Host-takosumi-unlink-browser";
export const CREDENTIAL_UNLINK_TTL_MS = 5 * 60_000;
const policyVersion = "retained-upstream-unlink@v1";

export class CredentialUnlinkConflict extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function isCredentialUnlinkIntentPath(path: string): boolean {
  if (path === inventoryPath || path === basePath) return true;
  const parts = path.slice(basePath.length + 1).split("/");
  return path.startsWith(`${basePath}/`) && operationPattern.test(parts[0] ?? "") &&
    (parts.length === 2 && parts[1] === "complete");
}

/** Mint the operation before any provider redirect; caller data is never proof. */
export async function createCredentialUnlinkIntent(input: {
  store: AccountsStore;
  session: AccountSessionRecord;
  removedIdentity: CredentialIdentityTuple;
  retainedIdentity: CredentialIdentityTuple;
  browserBindingHash: string;
  now: number;
}): Promise<CredentialUnlinkIntent> {
  const { store, session, now } = input;
  if (!store.createCredentialUnlinkIntent || !store.findCredentialUnlinkIntent ||
    !store.createCredentialUnlinkReceipt || !store.findCredentialUnlinkReceipt ||
    !store.completeCredentialUnlink || !store.getAccountAuthenticationGeneration ||
    !store.isHostedOidcSessionHashRevoked) throw new CredentialUnlinkConflict("unlink_unavailable");
  const issuerSessionHash = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
  const intent: CredentialUnlinkIntent = {
    operationId: `iunl_${crypto.randomUUID()}`,
    subject: session.subject,
    removedIdentity: { ...input.removedIdentity },
    retainedIdentity: { ...input.retainedIdentity },
    browserBindingHash: input.browserBindingHash,
    issuerSessionHash,
    identityGeneration: await store.getAccountAuthenticationGeneration(session.subject),
    policyVersion,
    status: "pending",
    revision: 0,
    createdAt: now,
    expiresAt: now + CREDENTIAL_UNLINK_TTL_MS,
    updatedAt: now,
  };
  await assertCredentialUnlinkIntentCurrent(store, intent, now);
  if (session.policy !== "hosted" || session.identityGeneration !== intent.identityGeneration ||
    session.expiresAt <= now || !session.absoluteExpiresAt || session.absoluteExpiresAt <= now ||
    !Number.isSafeInteger(session.authTime)) throw new CredentialUnlinkConflict("authentication_required");
  if (!await store.createCredentialUnlinkIntent(intent)) throw new CredentialUnlinkConflict("unlink_conflict");
  return intent;
}

export async function assertCredentialUnlinkIntentCurrent(
  store: AccountsStore,
  intent: CredentialUnlinkIntent,
  now: number,
): Promise<void> {
  if (intent.status !== "pending" || !operationPattern.test(intent.operationId) || intent.policyVersion !== policyVersion ||
    !Number.isSafeInteger(now) || !Number.isSafeInteger(intent.createdAt) || !Number.isSafeInteger(intent.expiresAt) ||
    intent.createdAt > now || intent.expiresAt <= now || intent.expiresAt > intent.createdAt + CREDENTIAL_UNLINK_TTL_MS ||
    intent.revision !== 0 || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(intent.issuerSessionHash) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(intent.browserBindingHash) ||
    upstreamIdentityKey(intent.removedIdentity) === upstreamIdentityKey(intent.retainedIdentity) ||
    !store.getAccountAuthenticationGeneration || !store.isHostedOidcSessionHashRevoked ||
    await store.getAccountAuthenticationGeneration(intent.subject) !== intent.identityGeneration ||
    await store.isHostedOidcSessionHashRevoked(intent.issuerSessionHash) ||
    await store.isAccountAuthenticationFenced?.(intent.subject) ||
    (await store.findCanonicalAccount?.(intent.subject))?.subject !== intent.subject) {
    throw new CredentialUnlinkConflict("unlink_conflict");
  }
  for (const tuple of [intent.removedIdentity, intent.retainedIdentity]) {
    const identity = await store.findUpstreamIdentity(tuple);
    const canonical = identity ? await store.findCanonicalAccount?.(identity.subject) : undefined;
    const status = await store.findUpstreamIdentityStatus?.(tuple);
    if (!identity || canonical?.subject !== intent.subject || status?.disabledAt !== undefined ||
      (status !== undefined && status.canonicalSubject !== intent.subject)) {
      throw new CredentialUnlinkConflict("unlink_conflict");
    }
  }
}

/** The adapter repeats these checks atomically while consuming/disabling. */
export async function completeCredentialUnlink(input: {
  store: AccountsStore;
  intent: CredentialUnlinkIntent;
  receiptId: string;
  reconciler?: CredentialUnlinkReconciler;
  now: number;
}): Promise<CredentialUnlinkIntent> {
  const { store, intent, now } = input;
  const beganAt = Date.now();
  if (intent.status === "completed" && intent.receiptId === input.receiptId) {
    const committed = await store.findCredentialUnlinkIntent?.(intent.operationId);
    if (committed?.status === "completed" && canonicalJson(committed) === canonicalJson(intent)) return committed;
    throw new CredentialUnlinkConflict("unlink_conflict");
  }
  if (!input.reconciler?.acknowledgeCredentialUnlinkIntent || !store.findCredentialUnlinkReceipt || !store.completeCredentialUnlink) {
    throw new CredentialUnlinkConflict("unlink_reconciliation_unavailable");
  }
  await assertCredentialUnlinkIntentCurrent(store, intent, now);
  const receipt = await store.findCredentialUnlinkReceipt(input.receiptId);
  validateCredentialUnlinkReceipt(intent, receipt, now);
  if(!store.createCredentialUnlinkAuthorityTicket||!store.findCredentialUnlinkAuthorityTicket)throw new CredentialUnlinkConflict("unlink_unavailable");
  const ticket={operationId:intent.operationId,subject:intent.subject,receiptId:receipt.receiptId,identityGeneration:intent.identityGeneration,createdAt:now};
  if(!await store.createCredentialUnlinkAuthorityTicket(ticket)){const prior=await store.findCredentialUnlinkAuthorityTicket(intent.operationId);if(!prior||prior.receiptId!==receipt.receiptId||prior.subject!==intent.subject||prior.identityGeneration!==intent.identityGeneration)throw new CredentialUnlinkConflict("unlink_conflict");}
  const acknowledgement = await input.reconciler.acknowledgeCredentialUnlinkIntent({
    operationId: intent.operationId,
    subject: intent.subject,
    removedIdentity: { ...intent.removedIdentity },
    retainedIdentity: { ...intent.retainedIdentity },
    receiptId: receipt.receiptId,
    identityGeneration: intent.identityGeneration,
  });
  const completedAt = now + Math.max(0, Date.now() - beganAt);
  if (!acknowledgement || acknowledgement.operationId !== intent.operationId || acknowledgement.subject !== intent.subject ||
    upstreamIdentityKey(acknowledgement.removedIdentity) !== upstreamIdentityKey(intent.removedIdentity) ||
    upstreamIdentityKey(acknowledgement.retainedIdentity) !== upstreamIdentityKey(intent.retainedIdentity) ||
    acknowledgement.receiptId !== receipt.receiptId || acknowledgement.identityGeneration !== intent.identityGeneration ||
    !acknowledgement.ownerRef || acknowledgement.ownerRef.length > 256 ||
    !Number.isSafeInteger(acknowledgement.acknowledgedAt) || acknowledgement.acknowledgedAt < receipt.completedAt || acknowledgement.acknowledgedAt > completedAt) {
    throw new CredentialUnlinkConflict("unlink_reconciliation_pending");
  }
  await assertCredentialUnlinkIntentCurrent(store, intent, completedAt);
  validateCredentialUnlinkReceipt(intent, receipt, completedAt);
  const next: CredentialUnlinkIntent = {
    ...intent,
    status: "completed",
    revision: intent.revision + 1,
    updatedAt: completedAt,
    receiptId: receipt.receiptId,
    acknowledgement,
  };
  if (!await store.completeCredentialUnlink({ expectedRevision: intent.revision, next, receipt, now: completedAt })) {
    throw new CredentialUnlinkConflict("unlink_conflict");
  }
  return next;
}

export function validateCredentialUnlinkReceipt(
  intent: CredentialUnlinkIntent,
  receipt: CredentialUnlinkReceipt | undefined,
  now: number,
): asserts receipt is CredentialUnlinkReceipt {
  if (!receipt || !/^iupr_[a-f0-9-]{36}$/u.test(receipt.receiptId) || receipt.method !== "upstream-oauth-operation" ||
    receipt.operationId !== intent.operationId || receipt.subject !== intent.subject ||
    upstreamIdentityKey(receipt.removedIdentity) !== upstreamIdentityKey(intent.removedIdentity) ||
    upstreamIdentityKey(receipt.retainedIdentity) !== upstreamIdentityKey(intent.retainedIdentity) ||
    receipt.browserBindingHash !== intent.browserBindingHash || receipt.issuerSessionHash !== intent.issuerSessionHash ||
    receipt.identityGeneration !== intent.identityGeneration || receipt.policyVersion !== intent.policyVersion ||
    receipt.legConsent !== true || receipt.legConsentAt !== receipt.startedAt ||
    !Number.isSafeInteger(receipt.startedAt) || !Number.isSafeInteger(receipt.completedAt) || !Number.isSafeInteger(receipt.expiresAt) ||
    receipt.startedAt < intent.createdAt || receipt.completedAt < receipt.startedAt || receipt.completedAt > now ||
    receipt.expiresAt <= now || receipt.expiresAt > receipt.startedAt + CREDENTIAL_UNLINK_TTL_MS || receipt.expiresAt > intent.expiresAt ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(receipt.transactionDigest) || receipt.consumedByOperation !== undefined) {
    throw new CredentialUnlinkConflict("unlink_conflict");
  }
}

export async function readCredentialUnlinkBrowserBindingHash(request: Request): Promise<string | undefined> {
  const value = readSingleCookie(request, browserCookie);
  return value && /^[a-f0-9]{64}$/u.test(value) ? await sha256Text(`unlink-browser:${value}`) : undefined;
}

/** Only the issuer's real browser cookie is accepted; an RP bearer is insufficient. */
export async function readCredentialUnlinkBrowserSession(store: AccountsStore, request: Request, now: number): Promise<AccountSessionRecord | undefined> {
  if (request.headers.has("authorization") || request.headers.has("x-takosumi-account-session")) return undefined;
  const raw = readSingleCookie(request, "__Host-takosumi_session");
  if (!raw || !/^sess_h_[A-Za-z0-9_-]{43}$/u.test(raw)) return undefined;
  const session = await store.findAccountSession(raw);
  if (!session || session.policy !== "hosted" || session.expiresAt <= now || !session.absoluteExpiresAt || session.absoluteExpiresAt <= now ||
    !Number.isSafeInteger(session.authTime) || session.authTime! < 0 || session.authTime! > Math.floor(now / 1000) + 60 ||
    !Number.isSafeInteger(session.createdAt) || session.createdAt > now ||
    session.absoluteExpiresAt > session.createdAt + HOSTED_SESSION_ABSOLUTE_MS || session.expiresAt > session.absoluteExpiresAt ||
    !store.getAccountAuthenticationGeneration ||
    session.identityGeneration !== await store.getAccountAuthenticationGeneration(session.subject) ||
    (await store.findCanonicalAccount?.(session.subject))?.subject !== session.subject || await store.isAccountAuthenticationFenced?.(session.subject)) return undefined;
  const anchor = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
  if (!store.isHostedOidcSessionHashRevoked || await store.isHostedOidcSessionHashRevoked(anchor)) return undefined;
  return session;
}

export async function readCredentialUnlinkJson(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}

export async function handleCredentialUnlinkIntentRequest(input: {
  request: Request;
  store: AccountsStore;
  issuerOrigin: string;
  reconciler?: CredentialUnlinkReconciler;
  now?: number;
}): Promise<Response | undefined> {
  const url = new URL(input.request.url);
  if (!isCredentialUnlinkIntentPath(url.pathname)) return undefined;
  const fail = (error: string, status: number) => withOAuthNoStoreHeaders(json({ error }, status));
  if (url.pathname === inventoryPath) return await handleCredentialInventoryRequest(input);
  if (input.request.method !== "POST") return fail("method_not_allowed", 405);
  const issuer = new URL(input.issuerOrigin);
  if (issuer.protocol !== "https:" || issuer.origin !== url.origin || input.request.headers.get("origin") !== issuer.origin) return fail("invalid_origin", 403);
  if (url.search) return fail("invalid_request", 400);
  const now = input.now ?? Date.now();
  const session = await readCredentialUnlinkBrowserSession(input.store, input.request, now);
  if (!session) return fail("authentication_required", 401);
  const body = await readCredentialUnlinkJson(input.request);
  if (!body) return fail("invalid_request", 400);
  try {
    let bindingHash = await readCredentialUnlinkBrowserBindingHash(input.request);
    if (url.pathname === basePath) {
      if (Object.keys(body).some((key) => !["removedIdentity", "retainedIdentity", "consent"].includes(key)) || body.consent !== true) return fail("invalid_request", 400);
      const removedIdentity = readTuple(body.removedIdentity);
      const retainedIdentity = readTuple(body.retainedIdentity);
      if (!removedIdentity || !retainedIdentity) return fail("invalid_request", 400);
      let cookie: string | undefined;
      if (!bindingHash) {
        const value = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        bindingHash = await sha256Text(`unlink-browser:${value}`);
        cookie = `${browserCookie}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`;
      }
      const intent = await createCredentialUnlinkIntent({ store: input.store, session, removedIdentity, retainedIdentity, browserBindingHash: bindingHash, now });
      return withOAuthNoStoreHeaders(json(publicIntent(intent), 201, cookie ? { "set-cookie": cookie } : undefined));
    }
    if (Object.keys(body).some((key) => !["receiptId", "consent"].includes(key)) || body.consent !== true || typeof body.receiptId !== "string" || body.receiptId.length > 64) return fail("invalid_request", 400);
    const operationId = url.pathname.slice(basePath.length + 1).split("/")[0]!;
    const intent = await input.store.findCredentialUnlinkIntent?.(operationId);
    const anchor = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
    if (!intent || !bindingHash || intent.browserBindingHash !== bindingHash || intent.subject !== session.subject || intent.issuerSessionHash !== anchor) return fail("unlink_unavailable", 403);
    const next = await completeCredentialUnlink({ store: input.store, intent, receiptId: body.receiptId, reconciler: input.reconciler, now });
    return withOAuthNoStoreHeaders(json(publicIntent(next), 200));
  } catch (error) {
    if (error instanceof CredentialUnlinkConflict) return fail(error.code, error.code.endsWith("unavailable") ? 503 : 409);
    return fail("unlink_unavailable", 503);
  }
}

async function handleCredentialInventoryRequest(input: {
  request: Request;
  store: AccountsStore;
  issuerOrigin: string;
  now?: number;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const fail = (error: string, status: number) => withOAuthNoStoreHeaders(json({ error }, status));
  if (input.request.method !== "GET") return fail("method_not_allowed", 405);
  const issuer = new URL(input.issuerOrigin);
  const origin = input.request.headers.get("origin");
  if (issuer.protocol !== "https:" || url.origin !== issuer.origin || (origin !== null && origin !== issuer.origin)) return fail("invalid_origin", 403);
  if (url.search) return fail("invalid_request", 400);
  const beganAt = Date.now();
  const now = input.now ?? beganAt;
  const { store } = input;
  const session = await readCredentialUnlinkBrowserSession(store, input.request, now);
  if (!session) return fail("authentication_required", 401);
  if (!store.listCanonicalUpstreamIdentities || !store.findCanonicalAccount ||
    !store.findUpstreamIdentityStatus || !store.isAccountAuthenticationFenced) return fail("credential_inventory_unavailable", 503);
  try {
    const records = await store.listCanonicalUpstreamIdentities(session.subject);
    if (records.length > 100) return fail("credential_inventory_unavailable", 503);
    const seen = new Set<string>();
    const credentials: Array<CredentialIdentityTuple & { enabled: boolean }> = [];
    for (const record of records) {
      const tuple = readTuple({ providerId: record.providerId, upstreamIssuer: record.upstreamIssuer, upstreamSubject: record.upstreamSubject });
      if (!tuple || seen.has(upstreamIdentityKey(tuple))) return fail("credential_inventory_unavailable", 503);
      seen.add(upstreamIdentityKey(tuple));
      const binding = await store.findUpstreamIdentity(tuple);
      const canonical = binding ? await store.findCanonicalAccount(binding.subject) : undefined;
      const status = await store.findUpstreamIdentityStatus(tuple);
      if (!binding || binding.subject !== record.subject || canonical?.subject !== session.subject ||
        (status !== undefined && status.canonicalSubject !== session.subject)) return fail("credential_inventory_unavailable", 503);
      credentials.push({ ...tuple, enabled: status?.disabledAt === undefined });
    }
    const current = await readCredentialUnlinkBrowserSession(store, input.request, now + Math.max(0, Date.now() - beganAt));
    if (!current || current.subject !== session.subject || current.identityGeneration !== session.identityGeneration) return fail("authentication_required", 401);
    credentials.sort((left, right) => upstreamIdentityKey(left).localeCompare(upstreamIdentityKey(right)));
    return withOAuthNoStoreHeaders(json({ credentials }, 200));
  } catch { return fail("credential_inventory_unavailable", 503); }
}

function readSingleCookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}

function readTuple(value: unknown): CredentialIdentityTuple | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || Object.keys(object).some((key) => !["providerId", "upstreamIssuer", "upstreamSubject"].includes(key)) ||
    ![object.providerId, object.upstreamIssuer, object.upstreamSubject].every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256)) return undefined;
  return object as unknown as CredentialIdentityTuple;
}

function publicIntent(intent: CredentialUnlinkIntent): unknown {
  return { operationId: intent.operationId, status: intent.status, removedIdentity: intent.removedIdentity, retainedIdentity: intent.retainedIdentity, expiresAt: intent.expiresAt };
}

function canonicalJson(value: unknown): string {
  const normalized = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalized);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalized(child)]));
    return entry;
  };
  return JSON.stringify(normalized(value));
}
