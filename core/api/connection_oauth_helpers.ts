import type { CreateConnectionRequest } from "@takosumi/internal/deploy-control-api";
import type { ConnectionOAuthDescriptor } from "@takosumi/providers";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import type {
  ConnectionOAuthCallbackInput,
  ConnectionOAuthCompletion,
  ConnectionOAuthHelper,
  ConnectionOAuthHelpers,
  ConnectionOAuthStartInput,
  ConnectionOAuthStartResponse,
} from "./deploy_control_shared.ts";

interface OAuthProviderConfig extends ConnectionOAuthDescriptor {
  readonly stateSecret: string;
}

interface SignedOAuthState {
  readonly helperId: string;
  readonly expiresAt: number;
  readonly body: ConnectionOAuthStartInput["body"];
  /**
   * Authenticated account subject of the caller that started the flow,
   * captured at `start` time and protected by the state HMAC. The cross-site
   * callback authorizes against this (it has no session cookie). Optional so a
   * previously-issued (legacy) state still verifies, but the dashboard callback
   * refuses to mint when it is absent.
   */
  readonly subject?: string;
}

export interface ConnectionOAuthHelperComposition {
  /** Host-owned HMAC secret for short-lived OAuth state. */
  readonly stateSecret?: string;
  /** Complete host-installed helper descriptor set. */
  readonly descriptors: readonly ConnectionOAuthDescriptor[];
}

/**
 * Build the provider-neutral OAuth engine from an explicit host contribution.
 * Core never discovers vendor descriptors from environment variables.
 */
export function createConnectionOAuthHelpers(
  composition: ConnectionOAuthHelperComposition,
  fetchImpl: typeof fetch = fetch,
): ConnectionOAuthHelpers | undefined {
  const stateSecret = composition.stateSecret?.trim();
  if (!stateSecret) return undefined;
  const helpers: Record<string, ConnectionOAuthHelper> = {};
  for (const descriptor of composition.descriptors) {
    const helperId = descriptor.id.trim();
    if (!helperId) {
      throw new Error("Connection OAuth helper id must be non-empty");
    }
    if (helpers[helperId]) {
      throw new Error(`duplicate Connection OAuth helper id: ${helperId}`);
    }
    helpers[helperId] = createOAuthHelperFromConfig(
      { ...descriptor, id: helperId, stateSecret },
      fetchImpl,
    );
  }
  return Object.keys(helpers).length > 0 ? helpers : undefined;
}

function createOAuthHelperFromConfig(
  config: OAuthProviderConfig,
  fetchImpl: typeof fetch,
): ConnectionOAuthHelper {
  return {
    start: async (input) => startOAuth(config, input),
    complete: async (input) => completeOAuth(config, input, fetchImpl),
  };
}

async function startOAuth(
  config: OAuthProviderConfig,
  input: ConnectionOAuthStartInput,
): Promise<ConnectionOAuthStartResponse> {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const state = await signState(
    {
      helperId: config.id,
      expiresAt,
      body: input.body,
      // Bind the OAuth state to the authenticated subject so the cross-site
      // callback can authorize from the signed state alone (no session cookie).
      ...(input.body.subject ? { subject: input.body.subject } : {}),
    },
    config.stateSecret,
  );
  const redirectUri = input.body.redirectUri ?? config.redirectUri;
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  if (config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(" "));
  }
  for (const [key, value] of Object.entries(config.authorizationParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return {
    authorizationUrl: url.toString(),
    state,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function completeOAuth(
  config: OAuthProviderConfig,
  input: ConnectionOAuthCallbackInput,
  fetchImpl: typeof fetch,
): Promise<ConnectionOAuthCompletion> {
  const state = await verifyState(input.state, config.stateSecret);
  if (state.helperId !== config.id) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth state helper id does not match callback route",
    );
  }
  if (state.expiresAt < Date.now()) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth state expired",
    );
  }
  const redirectUri = state.body.redirectUri ?? config.redirectUri;
  const tokenResponse = await exchangeCode(
    config,
    input.code,
    redirectUri,
    fetchImpl,
  );
  const values = valuesFromTokenResponse(config, tokenResponse);
  const request: CreateConnectionRequest = {
    ...(state.body.workspaceId ? { workspaceId: state.body.workspaceId } : {}),
    provider: config.providerSource,
    credentialRecipe: config.credentialRecipe,
    materialization: "oauth",
    ...(state.body.displayName ? { displayName: state.body.displayName } : {}),
    ...(state.body.scope ? { scope: state.body.scope } : {}),
    ...(state.body.scopeHints ? { scopeHints: state.body.scopeHints } : {}),
    ...(state.body.expiresAt ? { expiresAt: state.body.expiresAt } : {}),
    values,
  };
  // Surface the HMAC-signed subject so the cross-site callback can authorize
  // the mint against the account that actually started the flow. Prefer the
  // top-level signed `subject`; fall back to a subject the caller threaded
  // through `body` for older states.
  const subject = state.subject ?? state.body.subject;
  return subject ? { request, subject } : { request };
}

async function exchangeCode(
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    redirect_uri: redirectUri,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `OAuth token exchange failed with status ${response.status}`,
    );
  }
  const json = await response.json();
  if (!isRecord(json)) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "OAuth token response was not an object",
    );
  }
  return json;
}

function valuesFromTokenResponse(
  config: OAuthProviderConfig,
  tokenResponse: Record<string, unknown>,
): Readonly<Record<string, string>> {
  let mapped: Readonly<Record<string, string>>;
  try {
    mapped = config.mapTokenResponse({
      tokenResponse,
      helperId: config.id,
      clientId: config.clientId,
      ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    });
  } catch (error) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : `OAuth token response mapping failed for helper ${config.id}`,
    );
  }
  const entries = Object.entries(mapped);
  if (
    entries.length === 0 ||
    entries.some(
      ([key, value]) =>
        key.trim() === "" || typeof value !== "string" || value.length === 0,
    )
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `OAuth token response mapping for helper ${config.id} returned invalid connection values`,
    );
  }
  return Object.fromEntries(entries);
}

async function signState(
  state: SignedOAuthState,
  secret: string,
): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(state)),
  );
  const signature = await hmac(payload, secret);
  return `${payload}.${signature}`;
}

async function verifyState(
  token: string,
  secret: string,
): Promise<SignedOAuthState> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invalid OAuth state",
    );
  }
  const expected = await hmac(payload, secret);
  if (!constantTimeStringEquals(signature, expected)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invalid OAuth state",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invalid OAuth state",
    );
  }
  if (!isSignedOAuthState(parsed)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invalid OAuth state",
    );
  }
  return parsed;
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function constantTimeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function isSignedOAuthState(value: unknown): value is SignedOAuthState {
  if (!isRecord(value)) return false;
  return (
    typeof value.helperId === "string" &&
    value.helperId.trim() !== "" &&
    typeof value.expiresAt === "number" &&
    isRecord(value.body)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
