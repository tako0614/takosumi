import type {
  FetchLike,
  HostDiscovery,
  MobileAuthRequest,
  MobileKeyValueStore,
  MobileProductAdapter,
  MobileSession,
  NativeBridge,
  OidcTokenResponse,
} from "./types.ts";
import { createMobileReturnUri } from "./shell.ts";
import {
  createOidcAuthorizationUrl,
  createPkcePair,
  createRandomState,
  exchangeOidcCode,
  fetchOidcMetadata,
  parseOidcCallback,
} from "./oidc.ts";
import { isMobileProductKind } from "../../contract/mobile.ts";
import { requireMobileProductKey } from "./product-key.ts";

const MOBILE_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface BeginMobileOidcSignInInput {
  readonly adapter: MobileProductAdapter;
  readonly discovery: HostDiscovery;
  readonly nativeBridge: NativeBridge;
  readonly redirectPath?: string;
  readonly scope?: string;
  readonly fetch?: FetchLike;
  readonly crypto?: Crypto;
  readonly now?: () => Date;
}

export interface BeginMobileOidcSignInResult {
  readonly authorizationUrl: string;
  readonly request: MobileAuthRequest;
}

export interface CompleteMobileOidcSignInInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly callbackUrl: string;
  /**
   * Persist the exchanged session before returning it. Defaults to true for
   * backward compatibility. Controllers that need to reject stale async
   * completions can set this to false and call persistMobileSession only after
   * their generation check succeeds.
   */
  readonly persistSession?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export interface PersistMobileSessionInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly session: MobileSession;
}

export interface RefreshMobileSessionInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly session: MobileSession;
  /**
   * Persist the refreshed session before returning it. Defaults to true.
   * Lifecycle-aware controllers can disable this and commit only after their
   * generation check succeeds.
   */
  readonly persistSession?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export interface EnsureFreshMobileSessionInput extends RefreshMobileSessionInput {
  readonly expiresSkewMs?: number;
}

export function mobileAuthRequestStorageKey(
  adapter: MobileProductAdapter,
): string {
  return `takosumi.mobile.${requireMobileProductKey(adapter.product)}.auth.pending`;
}

export function mobileSessionStorageKey(adapter: MobileProductAdapter): string {
  return `takosumi.mobile.${requireMobileProductKey(adapter.product)}.session`;
}

export async function beginMobileOidcSignIn(
  input: BeginMobileOidcSignInInput,
): Promise<BeginMobileOidcSignInResult> {
  const store = requireMobileStore(input.nativeBridge);
  const oidcClientId = mobileClientId(input.discovery);
  const metadata = await fetchOidcMetadata({
    issuer: input.discovery.oidcIssuer,
    fetch: input.fetch,
  });
  const pkce = await createPkcePair(input.crypto);
  const state = createRandomState(input.crypto);
  const redirectUri = createMobileReturnUri(
    input.adapter,
    input.redirectPath ?? "oauth/callback",
  );
  const request: MobileAuthRequest = {
    hostUrl: input.discovery.hostUrl,
    product: input.adapter.product,
    oidcIssuer: input.discovery.oidcIssuer,
    oidcClientId,
    productEndpoints: normalizeProductEndpoints(
      input.discovery.product?.endpoints,
    ),
    redirectUri,
    state,
    codeVerifier: pkce.codeVerifier,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };

  await store.set(
    mobileAuthRequestStorageKey(input.adapter),
    stringify(request),
  );

  return {
    request,
    authorizationUrl: createOidcAuthorizationUrl({
      metadata,
      clientId: oidcClientId,
      redirectUri,
      state,
      codeChallenge: pkce.codeChallenge,
      scope: input.scope,
    }),
  };
}

export async function completeMobileOidcSignIn(
  input: CompleteMobileOidcSignInInput,
): Promise<MobileSession> {
  const store = requireMobileStore(input.nativeBridge);
  const request = await loadMobileAuthRequest(input.adapter, store, input.now);
  if (!request) throw new Error("No pending mobile sign-in request.");

  const callback = parseOidcCallback(input.callbackUrl, request.state);
  const metadata = await fetchOidcMetadata({
    issuer: request.oidcIssuer,
    fetch: input.fetch,
  });
  const token = await exchangeOidcCode({
    metadata,
    clientId: request.oidcClientId,
    redirectUri: request.redirectUri,
    code: callback.code,
    codeVerifier: request.codeVerifier,
    fetch: input.fetch,
  });
  const session = createMobileSession({
    request,
    token,
    now: input.now,
  });

  if (input.persistSession !== false) {
    await storeMobileSession(input.adapter, store, session);
  }
  await store.delete(mobileAuthRequestStorageKey(input.adapter));
  return session;
}

export async function persistMobileSession(
  input: PersistMobileSessionInput,
): Promise<void> {
  await storeMobileSession(
    input.adapter,
    requireMobileStore(input.nativeBridge),
    input.session,
  );
}

export async function ensureFreshMobileSession(
  input: EnsureFreshMobileSessionInput,
): Promise<MobileSession> {
  if (
    !mobileSessionNeedsRefresh(input.session, input.now, input.expiresSkewMs)
  ) {
    return input.session;
  }
  return await refreshMobileSession(input);
}

export async function refreshMobileSession(
  input: RefreshMobileSessionInput,
): Promise<MobileSession> {
  if (!input.session.refreshToken) {
    throw new Error("Mobile session has no refresh token.");
  }
  const store = requireMobileStore(input.nativeBridge);
  const oidcClientId = requireSessionMobileClientId(input.session);
  const metadata = await fetchOidcMetadata({
    issuer: input.session.oidcIssuer,
    fetch: input.fetch,
  });
  if (!metadata.token_endpoint) {
    throw new Error("OIDC issuer does not advertise a token endpoint.");
  }

  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oidcClientId,
      refresh_token: input.session.refreshToken,
    }),
  });
  if (!response.ok) {
    if (input.persistSession !== false) {
      await store.delete(mobileSessionStorageKey(input.adapter));
    }
    throw new Error(`Mobile session refresh failed: ${response.status}`);
  }
  const token = (await response.json()) as OidcTokenResponse;
  const session = createMobileSessionFromRefresh({
    session: input.session,
    token,
    now: input.now,
  });
  if (input.persistSession !== false) {
    await storeMobileSession(input.adapter, store, session);
  }
  return session;
}

export async function loadMobileSession(input: {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}): Promise<MobileSession | undefined> {
  const raw = await getFromMobileStores(
    input.nativeBridge,
    mobileSessionStorageKey(input.adapter),
  );
  if (!raw) return undefined;
  return parseMobileSession(raw);
}

export async function clearMobileSession(input: {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}): Promise<void> {
  await deleteFromMobileStores(
    input.nativeBridge,
    mobileSessionStorageKey(input.adapter),
  );
}

export function isOidcCallbackPayload(payload: string): boolean {
  try {
    const url = new URL(payload);
    return url.searchParams.has("code") || url.searchParams.has("error");
  } catch {
    return false;
  }
}

function createMobileSession(input: {
  readonly request: MobileAuthRequest;
  readonly token: OidcTokenResponse;
  readonly now?: () => Date;
}): MobileSession {
  const createdAtDate = input.now?.() ?? new Date();
  const createdAt = createdAtDate.toISOString();
  return {
    hostUrl: input.request.hostUrl,
    product: input.request.product,
    oidcIssuer: input.request.oidcIssuer,
    oidcClientId: input.request.oidcClientId,
    productEndpoints: input.request.productEndpoints,
    accessToken: input.token.access_token,
    tokenType: input.token.token_type,
    refreshToken: input.token.refresh_token,
    idToken: input.token.id_token,
    scope: input.token.scope,
    createdAt,
    expiresAt:
      typeof input.token.expires_in === "number"
        ? new Date(
            createdAtDate.getTime() + input.token.expires_in * 1000,
          ).toISOString()
        : undefined,
  };
}

function createMobileSessionFromRefresh(input: {
  readonly session: MobileSession;
  readonly token: OidcTokenResponse;
  readonly now?: () => Date;
}): MobileSession {
  const createdAtDate = input.now?.() ?? new Date();
  const createdAt = createdAtDate.toISOString();
  return {
    hostUrl: input.session.hostUrl,
    product: input.session.product,
    oidcIssuer: input.session.oidcIssuer,
    oidcClientId: input.session.oidcClientId,
    productEndpoints: input.session.productEndpoints,
    accessToken: input.token.access_token,
    tokenType: input.token.token_type,
    refreshToken: input.token.refresh_token ?? input.session.refreshToken,
    idToken: input.token.id_token ?? input.session.idToken,
    scope: input.token.scope ?? input.session.scope,
    createdAt,
    expiresAt:
      typeof input.token.expires_in === "number"
        ? new Date(
            createdAtDate.getTime() + input.token.expires_in * 1000,
          ).toISOString()
        : undefined,
  };
}

function mobileSessionNeedsRefresh(
  session: MobileSession,
  now: (() => Date) | undefined,
  expiresSkewMs = 60_000,
): boolean {
  if (!session.expiresAt) return false;
  if (!session.refreshToken) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - (now?.() ?? new Date()).getTime() <= expiresSkewMs;
}

async function loadMobileAuthRequest(
  adapter: MobileProductAdapter,
  store: MobileKeyValueStore,
  now: (() => Date) | undefined,
): Promise<MobileAuthRequest | undefined> {
  const raw = await store.get(mobileAuthRequestStorageKey(adapter));
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Partial<MobileAuthRequest>;
  if (
    typeof parsed.hostUrl !== "string" ||
    parsed.product !== adapter.product ||
    typeof parsed.oidcIssuer !== "string" ||
    typeof parsed.oidcClientId !== "string" ||
    !isOptionalProductEndpoints(parsed.productEndpoints) ||
    typeof parsed.redirectUri !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Stored mobile sign-in request is invalid.");
  }
  const createdAtMs = Date.parse(parsed.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error("Stored mobile sign-in request is invalid.");
  }
  if (
    (now?.() ?? new Date()).getTime() - createdAtMs >
    MOBILE_AUTH_REQUEST_TTL_MS
  ) {
    await store.delete(mobileAuthRequestStorageKey(adapter));
    throw new Error("Pending mobile sign-in request has expired.");
  }
  return {
    ...(parsed as MobileAuthRequest),
    productEndpoints: normalizeProductEndpoints(parsed.productEndpoints),
  };
}

function parseMobileSession(raw: string): MobileSession {
  const parsed = JSON.parse(raw) as Partial<MobileSession>;
  if (
    typeof parsed.hostUrl !== "string" ||
    !isMobileProductKind(parsed.product) ||
    typeof parsed.oidcIssuer !== "string" ||
    (parsed.oidcClientId !== undefined &&
      typeof parsed.oidcClientId !== "string") ||
    !isOptionalProductEndpoints(parsed.productEndpoints) ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.tokenType !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Stored mobile session is invalid.");
  }
  return {
    ...(parsed as MobileSession),
    productEndpoints: normalizeProductEndpoints(parsed.productEndpoints),
  };
}

function normalizeProductEndpoints(
  value: unknown,
): MobileSession["productEndpoints"] {
  if (value == null) return undefined;
  if (!isProductEndpointsRecord(value)) return undefined;
  const endpoints: Record<string, string> = {};
  for (const [key, endpoint] of Object.entries(value)) {
    const trimmed = endpoint.trim();
    if (trimmed) endpoints[key] = trimmed;
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}

function isOptionalProductEndpoints(value: unknown): boolean {
  return value == null || isProductEndpointsRecord(value);
}

function isProductEndpointsRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((endpoint) => typeof endpoint === "string")
  );
}

function mobileClientId(discovery: HostDiscovery): string {
  const clientId = discovery.oidcClientId?.trim();
  if (!clientId) {
    throw new Error("Host does not advertise a mobile OIDC client id.");
  }
  return clientId;
}

function requireSessionMobileClientId(session: MobileSession): string {
  const clientId = session.oidcClientId?.trim();
  if (!clientId) {
    throw new Error("Mobile session is missing its OIDC client id.");
  }
  return clientId;
}

function requireMobileStore(nativeBridge: NativeBridge): MobileKeyValueStore {
  const store = nativeBridge.secureStore ?? nativeBridge.storage;
  if (!store) {
    throw new Error("Mobile auth storage is unavailable.");
  }
  return store;
}

async function getFromMobileStores(
  nativeBridge: NativeBridge,
  key: string,
): Promise<string | undefined> {
  const secureValue = await nativeBridge.secureStore?.get(key);
  if (secureValue !== undefined) return secureValue;
  return await nativeBridge.storage?.get(key);
}

async function deleteFromMobileStores(
  nativeBridge: NativeBridge,
  key: string,
): Promise<void> {
  await Promise.all([
    nativeBridge.secureStore?.delete(key),
    nativeBridge.storage?.delete(key),
  ]);
}

async function storeMobileSession(
  adapter: MobileProductAdapter,
  store: MobileKeyValueStore,
  session: MobileSession,
): Promise<void> {
  await store.set(mobileSessionStorageKey(adapter), stringify(session));
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
