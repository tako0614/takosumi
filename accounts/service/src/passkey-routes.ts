import { authenticatePasskey, registerPasskeyCredential } from "./identity.ts";
import {
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  verifyPasskeyAttestationFormat,
  verifyPasskeyRegistrationClientData,
} from "./passkey.ts";
import type { AccountsStore } from "./store.ts";
import type { PasskeyHttpOptions } from "./mod.ts";
import {
  errorJson,
  base64UrlBytesValue,
  isRecord,
  json,
  numberValue,
  readJsonObject,
  stringArrayValue,
  stringValue,
  takosumiSubjectValue,
} from "./http-helpers.ts";
import {
  extractAccountSessionId,
  rotateAccountSession,
  serializeAccountSessionCookie,
} from "./account-session.ts";
import {
  type PasskeyChallengeIntent,
  passkeyChallengeKey,
} from "./passkey-challenge-store.ts";
import { consoleErrorRedacted } from "./redacted-log.ts";

/**
 * Server-minted passkey challenge handling. Browsers must NOT pick their own
 * challenge — that defeats the purpose of WebAuthn replay protection. We mint a
 * 32-byte random challenge, bind it to `subject + sessionId + intent` (register
 * / authenticate), and require the client to echo back the SAME bytes on
 * `complete`.
 *
 * The challenge is persisted in the `AccountsStore` (via `savePasskeyChallenge`
 * / `consumePasskeyChallenge`), NOT a module-local Map. The previous Map was
 * wrong on the Cloudflare Workers (D1) reference distribution, which is
 * multi-isolate with no request affinity: the `/options` and `/complete`
 * requests routinely hit different isolates, so the Map both broke legitimate
 * logins (`unknown_challenge`) and only enforced single-use per-isolate. The
 * store gives the same delete-on-read, internal-expiry, cross-replica
 * guarantees as `authorization_codes`. TTL is 5 minutes (matches the WebAuthn
 * `timeout` default).
 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function mintChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function issueChallenge(input: {
  store: AccountsStore;
  subject: string;
  sessionId: string | null;
  intent: PasskeyChallengeIntent;
}): Promise<string> {
  const challenge = mintChallenge();
  const key = passkeyChallengeKey(input);
  await input.store.savePasskeyChallenge(
    key,
    challenge,
    Date.now() + CHALLENGE_TTL_MS,
  );
  return challenge;
}

type ConsumeResult =
  | { ok: true; challenge: string }
  | { ok: false; error: "unknown_challenge" };

async function consumeChallenge(input: {
  store: AccountsStore;
  subject: string;
  sessionId: string | null;
  intent: PasskeyChallengeIntent;
  presented: string;
}): Promise<ConsumeResult> {
  const key = passkeyChallengeKey(input);
  // Single-shot read+delete in the store with internal expiry handling
  // (mirrors consumeAuthorizationCode). `undefined` covers unknown AND expired;
  // either way we fail closed.
  const stored = await input.store.consumePasskeyChallenge(key, Date.now());
  if (stored === undefined || stored !== input.presented) {
    return { ok: false, error: "unknown_challenge" };
  }
  return { ok: true, challenge: stored };
}

export async function handlePasskeyRegisterOptions(input: {
  request: Request;
  store: AccountsStore;
  passkeys: PasskeyHttpOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const subject = takosumiSubjectValue(body.subject);
  if (!subject) return errorJson("invalid_request", "invalid request", 400);

  const account = await input.store.findAccount(subject);
  if (!account) return errorJson("account_not_found", "account not found", 404);

  // Agent 6 item 3: bind the issued challenge to subject + session. If
  // the caller already has an authenticated session (re-registration of
  // an additional credential), pin it; otherwise we issue an "anon" key
  // keyed only by subject (first-time enrollment from a sign-in flow
  // that has not yet minted a session).
  const sessionId = extractAccountSessionId(input.request);
  const challenge = await issueChallenge({
    store: input.store,
    subject,
    sessionId,
    intent: "register",
  });
  return json(
    createPasskeyRegistrationOptions({
      rp: {
        id: input.passkeys.rpId,
        name: input.passkeys.rpName,
      },
      user: {
        id: subject,
        name: stringValue(body.userName) ?? account.email ?? subject,
        displayName:
          stringValue(body.displayName) ??
          account.displayName ??
          account.email ??
          subject,
      },
      challenge,
    }),
  );
}

export async function handlePasskeyRegisterComplete(input: {
  request: Request;
  store: AccountsStore;
  passkeys: PasskeyHttpOptions;
}): Promise<Response> {
  // Agent 6 item 1: passkey enrollment must be done on behalf of an
  // already-authenticated Account session. Without this gate any caller
  // could attach a passkey to any subject they can name.
  const sessionId = extractAccountSessionId(input.request);
  if (!sessionId || !sessionId.startsWith("sess_")) {
    return errorJson("invalid_session", "invalid session", 401, undefined, {
      "www-authenticate": `Bearer error="invalid_session"`,
    });
  }
  const session = await input.store.findAccountSession(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    return errorJson("invalid_session", "invalid session", 401, undefined, {
      "www-authenticate": `Bearer error="invalid_session"`,
    });
  }

  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const subject = takosumiSubjectValue(body.subject);
  const credentialId = stringValue(body.credentialId);
  const publicKeyJwk = isRecord(body.publicKeyJwk)
    ? (body.publicKeyJwk as JsonWebKey)
    : undefined;
  // Agent 6 item 2 + 4 (fail-closed): the registration ceremony fields are
  // MANDATORY, symmetric with authenticate/complete. Previously they were
  // optional, so a caller that simply omitted `challenge` skipped ALL
  // challenge / clientDataJSON / attestation verification and bound an
  // arbitrary public key to the session subject. The `/options` endpoint
  // always mints a challenge and a real WebAuthn client always produces
  // clientDataJSON + attestationObject, so requiring them is correct.
  const presentedChallenge = stringValue(body.challenge);
  const clientDataJSON = base64UrlBytesValue(body.clientDataJSON);
  const attestationObject = base64UrlBytesValue(body.attestationObject);
  if (
    !subject ||
    !credentialId ||
    !publicKeyJwk ||
    !presentedChallenge ||
    !clientDataJSON ||
    !attestationObject
  ) {
    return errorJson("invalid_request", "invalid request", 400);
  }

  // Agent 6 item 1: the subject the client wants to attach the passkey to
  // must be the same subject the session belongs to. Reject otherwise.
  if (subject !== session.subject) {
    return errorJson("subject_mismatch", "subject mismatch", 403);
  }

  // Agent 6 item 2: the challenge presented on complete must match the
  // server-minted challenge stored on the matching options call. Look up
  // via the same (subject, sessionId, intent) tuple used at issue time.
  {
    const consumed = await consumeChallenge({
      store: input.store,
      subject,
      sessionId,
      intent: "register",
      presented: presentedChallenge,
    });
    if (!consumed.ok) {
      return errorJson(
        consumed.error,
        consumed.error.replaceAll("_", " "),
        400,
      );
    }
    // Agent 6 item 4: verify the registration ceremony matches the issued
    // challenge / origin / attestation policy. These checks are now always
    // run because the fields above are mandatory.
    try {
      verifyPasskeyRegistrationClientData({
        expectedChallenge: consumed.challenge,
        expectedOrigin: input.passkeys.origin,
        clientDataJSON,
      });
    } catch (error) {
      consoleErrorRedacted("passkey_registration_clientdata_failed", error);
      return errorJson(
        "passkey_registration_failed",
        "passkey registration verification failed",
        400,
      );
    }
    try {
      await verifyPasskeyAttestationFormat({
        attestationObject,
        expectedFormat: "none",
        rpId: input.passkeys.rpId,
      });
    } catch (error) {
      consoleErrorRedacted("passkey_registration_attestation_failed", error);
      return errorJson(
        "passkey_registration_failed",
        "passkey registration verification failed",
        400,
      );
    }
  }

  try {
    const credential = await registerPasskeyCredential({
      store: input.store,
      subject,
      credentialId,
      publicKeyJwk,
      signCount: numberValue(body.signCount) ?? 0,
      transports: stringArrayValue(body.transports),
    });
    return json({
      credential_id: credential.credentialId,
      subject: credential.subject,
      sign_count: credential.signCount,
    });
  } catch (error) {
    consoleErrorRedacted("passkey_registration_failed", error);
    return errorJson(
      "passkey_registration_failed",
      "passkey registration failed",
      400,
    );
  }
}

export async function handlePasskeyAuthenticateOptions(input: {
  request: Request;
  store: AccountsStore;
  passkeys: PasskeyHttpOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const subject = takosumiSubjectValue(body.subject);
  if (!subject) return errorJson("invalid_request", "invalid request", 400);
  const account = await input.store.findAccount(subject);
  if (!account) return errorJson("account_not_found", "account not found", 404);

  const credentials =
    await input.store.listPasskeyCredentialsForSubject(subject);

  // Agent 6 item 2 + 3: server-mint challenge keyed by (subject,
  // sessionId, intent). For authenticate, sessionId is normally null
  // (this is the pre-login flow), but if the caller is already signed in
  // and registering a step-up, we still bind to the existing session.
  const sessionId = extractAccountSessionId(input.request);
  const challenge = await issueChallenge({
    store: input.store,
    subject,
    sessionId,
    intent: "authenticate",
  });
  return json(
    createPasskeyAuthenticationOptions({
      rpId: input.passkeys.rpId,
      challenge,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        type: "public-key" as const,
      })),
    }),
  );
}

export async function handlePasskeyAuthenticateComplete(input: {
  request: Request;
  store: AccountsStore;
  passkeys: PasskeyHttpOptions;
  secureCookie: boolean;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const credentialId = stringValue(body.credentialId);
  const expectedChallenge = stringValue(body.expectedChallenge);
  const authenticatorData = base64UrlBytesValue(body.authenticatorData);
  const clientDataJSON = base64UrlBytesValue(body.clientDataJSON);
  const signature = base64UrlBytesValue(body.signature);
  if (
    !credentialId ||
    !expectedChallenge ||
    !authenticatorData ||
    !clientDataJSON ||
    !signature
  ) {
    return errorJson("invalid_request", "invalid request", 400);
  }

  // Agent 6 item 2: verify the server-minted challenge by looking up the
  // record we stored on the matching options call. We don't know subject
  // yet (we'll know after authenticatePasskey resolves it from the
  // credentialId); use the credential subject after lookup. To support
  // pre-login (no session) the consume key is the same as issue.
  const existingCredential =
    await input.store.findPasskeyCredential(credentialId);
  if (!existingCredential) {
    return errorJson(
      "passkey_authentication_failed",
      "passkey credential is not registered",
      401,
    );
  }
  const presentingSessionId = extractAccountSessionId(input.request);
  const consumed = await consumeChallenge({
    store: input.store,
    subject: existingCredential.subject,
    sessionId: presentingSessionId,
    intent: "authenticate",
    presented: expectedChallenge,
  });
  if (!consumed.ok) {
    return errorJson(consumed.error, consumed.error.replaceAll("_", " "), 400);
  }

  try {
    const result = await authenticatePasskey({
      store: input.store,
      credentialId,
      expectedChallenge: consumed.challenge,
      expectedOrigin: input.passkeys.origin,
      rpId: input.passkeys.rpId,
      authenticatorData,
      clientDataJSON,
      signature,
    });
    const now = Date.now();
    // Agent 6 item 8: rotate the session id on successful authentication.
    // If the caller presented a prior session, revoke it; otherwise just
    // mint a new one.
    const ttlMs = input.passkeys.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    const rotated = await rotateAccountSession({
      store: input.store,
      oldSessionId: presentingSessionId,
      subject: result.account.subject,
      now,
      ttlMs,
    });

    // Agent 6 item 6 (parity with OAuth callback): set the session via
    // an HttpOnly cookie. Do NOT return the session_id in the body —
    // browser clients should rely on the cookie; programmatic callers
    // (CLI / Tauri) should send the Authorization bearer themselves and
    // are not the primary user of this endpoint.
    const cookie = serializeAccountSessionCookie(rotated.sessionId, {
      secure: input.secureCookie,
      maxAgeSeconds: Math.max(1, Math.floor(ttlMs / 1000)),
    });
    return json(
      {
        subject: result.account.subject,
        expires_at: rotated.expiresAt,
        credential_id: result.credential.credentialId,
      },
      200,
      {
        "set-cookie": cookie,
      },
    );
  } catch (error) {
    consoleErrorRedacted("passkey_authentication_failed", error);
    return errorJson(
      "passkey_authentication_failed",
      "passkey authentication failed",
      401,
    );
  }
}
