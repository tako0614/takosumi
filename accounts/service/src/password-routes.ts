import { argon2idAsync } from "@noble/hashes/argon2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { constantTimeEqualsBytes } from "takosumi-contract/internal/crypto";
import { readOrdinaryAccountAuthenticationGeneration } from "./account-authentication-generation.ts";
import {
  extractAccountSessionId,
  requireAccountSession,
  rotateAccountSession,
  serializeAccountSessionCookie,
} from "./account-session.ts";
import { sha256Text } from "./encoding.ts";
import { readBoundedRequestText, RequestBodyReadError } from "./http-helpers.ts";
import { accountMatchesLoginAllowlist, normalizeLoginEmail, type LoginEmailAllowlist } from "./login-email-allowlist.ts";
import type { PasswordAuthStore, PasswordCredential } from "./password-store.ts";
import type { AccountsStore, TakosumiAccountRecord } from "./store.ts";

const LOGIN = "/api/v1/auth/password/login";
const METHODS = "/api/v1/account/sign-in-methods";
const UPDATE = METHODS + "/password";
const WINDOW_MS = 15 * 60 * 1000;
const FRESH_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH = /^argon2id:v19:m19456:t2:p1:([a-f0-9]{32}):([a-f0-9]{64})$/u;
let activeDerivations = 0;
const COMMON_PASSWORD = /^(?:password|qwerty|letmein|welcome|admin(?:istrator)?|changeme|iloveyou)(?:[0-9]+|password|qwerty|letmein|welcome|admin|changeme|iloveyou)+$/u;

export function isPasswordAuthPath(path: string): boolean {
  return path === LOGIN || path === METHODS || path === UPDATE;
}

function response(value: object, status = 200, extra?: Record<string, string>): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

function error(code: string, status: number, extra?: Record<string, string>): Response {
  return response({ error: code }, status, extra);
}

const invalid = () => error("invalid_credentials", 401);
const throttled = () => error("rate_limited", 429, { "Retry-After": "900" });

function emailFrom(input: unknown): string | undefined {
  return typeof input === "string" && input.length <= 254 && !/[\u0000-\u001f\u007f]/u.test(input)
    ? normalizeLoginEmail(input)
    : undefined;
}

function passwordFrom(input: unknown): string | undefined {
  if (typeof input !== "string" || /[\uD800-\uDFFF]/u.test(input)) return undefined;
  const value = input.normalize("NFC");
  const length = [...value].length;
  return length >= 15 && length <= 128 ? value : undefined;
}

function blocksPassword(value: string, email: string): boolean {
  const lowered = value.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/gu, "");
  return lowered.trim() === email || /^(.)\1+$/u.test(lowered) ||
    /^1234567890(?:1234567890)*[0-9]*$/u.test(compact) ||
    compact === "correcthorsebatterystaple" || COMMON_PASSWORD.test(compact);
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  // 19 MiB per call. Keep concurrent requests below the Worker isolate cap.
  if (activeDerivations >= 2) throw new Error("password derivation busy");
  activeDerivations++;
  try {
    return await argon2idAsync(password, salt, { m: 19456, t: 2, p: 1, dkLen: 32 });
  } finally {
    activeDerivations--;
  }
}

async function passwordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  return `argon2id:v19:m19456:t2:p1:${bytesToHex(salt)}:${bytesToHex(hash)}`;
}

async function matchesPassword(password: string, stored: string | undefined): Promise<boolean> {
  const match = stored?.match(PASSWORD_HASH);
  // Missing, ambiguous and OAuth-only accounts have the same derivation cost.
  const actual = await derive(password, match ? hexToBytes(match[1]!) : new Uint8Array(16));
  return constantTimeEqualsBytes(actual, match ? hexToBytes(match[2]!) : new Uint8Array(32)) && Boolean(match);
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return error("invalid_request", 415);
  }
  try {
    const input: unknown = JSON.parse(await readBoundedRequestText(request, 4096));
    return input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : error("invalid_request", 400);
  } catch (cause) {
    return error("invalid_request", cause instanceof RequestBodyReadError ? cause.status : 400);
  }
}

async function admit(port: PasswordAuthStore, action: "login" | "manage", clientKey: string | undefined, identity: string | undefined, now: number): Promise<boolean> {
  // A shared volume ceiling bounds cost and the number of new counter rows.
  if (!await port.consumeAttempt(`${action}:all`, now, 240, WINDOW_MS)) return false;
  if (clientKey && !await port.consumeAttempt(`${action}:source:${await sha256Text(clientKey.slice(0, 128))}`, now, 45, WINDOW_MS)) {
    return false;
  }
  return identity === undefined ||
    await port.consumeAttempt(`${action}:identity:${await sha256Text(identity)}`, now, 12, WINDOW_MS);
}

interface PasswordRouteOptions {
  request: Request;
  path: string;
  issuer: string;
  store: AccountsStore;
  enabled: boolean;
  allowlist?: LoginEmailAllowlist;
  hostedPolicy?: boolean;
  secureCookie: boolean;
  clientKey?: string;
}

async function canonical(options: PasswordRouteOptions, subject: TakosumiSubject): Promise<boolean> {
  return (await options.store.findCanonicalAccount?.(subject))?.subject === subject &&
    !await options.store.isAccountAuthenticationFenced?.(subject);
}

async function generationFor(options: PasswordRouteOptions, subject: TakosumiSubject): Promise<number> {
  if (!options.hostedPolicy) return readOrdinaryAccountAuthenticationGeneration(options.store, subject);
  const generation = await options.store.getAccountAuthenticationGeneration?.(subject);
  if (generation === undefined) throw new Error("account authentication generation unavailable");
  return generation;
}

async function issueSession(options: PasswordRouteOptions, credential: PasswordCredential, email: string, generation: number): Promise<Response> {
  const { store, request, hostedPolicy, secureCookie } = options;
  const now = Date.now();
  if (!await canonical(options, credential.subject)) return invalid();
  if (generation !== await generationFor(options, credential.subject)) return invalid();
  const old = extractAccountSessionId(request);
  const previous = old ? await store.findAccountSession(old) : undefined;
  const next = await rotateAccountSession({
    store,
    oldSessionId: previous?.subject === credential.subject ? old : undefined,
    subject: credential.subject,
    now,
    ttlMs: SESSION_TTL_MS,
    hostedPolicy,
    freshlyAuthenticatedAt: Math.floor(now / 1000),
  });

  // An identity, email, or password change can race the derivation or mint.
  // Revoke the freshly minted session and return no cookie in that case.
  const current = await store.passwordAuth!.findBySubject(credential.subject);
  const account = await store.findAccountByVerifiedEmail(email, { unique: true });
  if (current?.version !== credential.version || account?.subject !== credential.subject ||
      !accountMatchesLoginAllowlist(account, options.allowlist) ||
      generation !== await generationFor(options, credential.subject) ||
      !await canonical(options, credential.subject)) {
    await store.deleteAccountSession(next.sessionId);
    return invalid();
  }
  return response({ subject: credential.subject }, 200, {
    "Set-Cookie": serializeAccountSessionCookie(next.sessionId, {
      secure: secureCookie, hostedPolicy, maxAgeSeconds: Math.max(1, Math.floor((next.expiresAt - now) / 1000)),
    }),
  });
}

async function login(options: PasswordRouteOptions, port: PasswordAuthStore, now: number): Promise<Response> {
  const input = await body(options.request);
  if (input instanceof Response) return input;
  const email = emailFrom(input.email);
  const password = passwordFrom(input.password);
  if (!await admit(port, "login", options.clientKey, email, now)) return throttled();
  if (!email || !password) return invalid();
  const account = await options.store.findAccountByVerifiedEmail(email, { unique: true });
  const credential = account && await port.findBySubject(account.subject);
  const generation = credential ? await generationFor(options, credential.subject) : 0;
  const matches = await matchesPassword(password, credential?.passwordHash);
  if (!matches || !credential || !account || account.emailVerified !== true ||
      !accountMatchesLoginAllowlist(account, options.allowlist)) return invalid();
  return issueSession(options, credential, email, generation);
}

async function eligibleEmail(options: PasswordRouteOptions, account: TakosumiAccountRecord): Promise<string | undefined> {
  const email = account.emailVerified === true ? emailFrom(account.email) : undefined;
  if (!email || (await options.store.findAccountByVerifiedEmail(email, { unique: true }))?.subject !== account.subject) return undefined;
  const identities = await options.store.listCanonicalUpstreamIdentities?.(account.subject);
  return identities?.length ? email : undefined;
}

async function management(options: PasswordRouteOptions, port: PasswordAuthStore, now: number): Promise<Response> {
  const { request, path, store } = options;
  // Use the issuer browser's HttpOnly cookie for credential management.
  if (request.headers.has("authorization") || request.headers.has("x-takosumi-account-session")) return invalid();
  const verified = await requireAccountSession({ request, store });
  if (!verified.ok) return invalid();
  const [account, session, current] = await Promise.all([
    store.findAccount(verified.subject), store.findAccountSession(verified.sessionId), port.findBySubject(verified.subject),
  ]);
  if (!account || !session || !accountMatchesLoginAllowlist(account, options.allowlist) ||
      !await canonical(options, verified.subject)) return invalid();
  const generation = await generationFor(options, verified.subject);
  if ((session.identityGeneration ?? 0) !== generation) return invalid();
  const email = await eligibleEmail(options, account);
  const authTime = (session.reauthenticatedAt ?? session.authTime ?? Math.floor(session.createdAt / 1000)) * 1000;
  const authenticatedAt = Math.min(session.createdAt, authTime);
  const fresh = authenticatedAt <= now && now - authenticatedAt <= FRESH_MS;
  if (path === METHODS) {
    return response({
      passwordEnabled: true, email: email ?? null, hasPassword: Boolean(current),
      canSetPassword: Boolean(email) && (fresh || Boolean(current)),
    });
  }
  if (!email) return error("verified_email_required", 403);
  if (!await admit(port, "manage", options.clientKey, verified.subject, now)) return throttled();
  const input = await body(request);
  if (input instanceof Response) return input;
  const proof = passwordFrom(input.currentPassword);
  const currentProof = proof && current ? await matchesPassword(proof, current.passwordHash) : false;
  if (input.currentPassword !== undefined ? !currentProof : !fresh) {
    return error("reauthentication_required", 403);
  }
  const password = passwordFrom(input.password);
  if (!password) return error("invalid_input", 400);
  if (blocksPassword(password, email)) return error("weak_password", 400);
  const next: PasswordCredential = {
    subject: verified.subject, version: (current?.version ?? 0) + 1, passwordHash: await passwordHash(password),
  };
  const authorization = {
    sessionId: verified.sessionId,
    generation,
    now: Date.now(),
    verifiedEmail: email,
    ...(currentProof ? {} : { freshUntil: authenticatedAt + FRESH_MS }),
  };
  const saved = current
    ? await port.replace(current.version, next, authorization.now, authorization)
    : await port.create(next, authorization);
  if (!saved) return error("credential_changed", 409);
  return issueSession(options, next, email, generation + Number(Boolean(current)));
}

export async function handlePasswordAuth(options: PasswordRouteOptions): Promise<Response> {
  const port = options.store.passwordAuth;
  if (!options.enabled || !port) return error("not_found", 404);
  const { request, path } = options;
  const method = path === METHODS ? "GET" : "POST";
  if (request.method !== method) return error("method_not_allowed", 405, { Allow: method });
  if (method === "POST" && request.headers.get("origin") !== new URL(options.issuer).origin) {
    return error("access_denied", 403);
  }
  try {
    const now = Date.now();
    return path === LOGIN ? await login(options, port, now) : await management(options, port, now);
  } catch {
    // Raw errors can contain verifier material or operator config.
    return error("authentication_unavailable", 503);
  }
}
