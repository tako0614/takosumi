// WebAuthn challenge key helper for the passkey ceremony.
//
// WHY STORE-BACKED
// ----------------
// The passkey register/authenticate ceremony is two HTTP requests: `/options`
// mints a server-side challenge, `/complete` must verify the client echoed the
// SAME challenge bytes (replay protection) and single-use it. That state must
// be durable and cross-request/cross-replica.
//
// The previous implementation kept the challenge in a module-local `Map`, which
// is wrong on the Cloudflare Workers (D1) reference distribution: that
// distribution is multi-isolate with no request affinity, so `/options` and
// `/complete` routinely land on different isolates. The Map made legitimate
// logins fail with `unknown_challenge` and made the single-use replay guarantee
// only hold per-isolate.
//
// The persistence now lives on `AccountsStore` (owned by CLOUD-STORES) as
// `savePasskeyChallenge(key, challenge, expiresAt)` /
// `consumePasskeyChallenge(key, now)` — single-shot delete-on-read with
// internal expiry, mirroring `consumeAuthorizationCode`. This module only owns
// the opaque key composition the routes use.

export type PasskeyChallengeIntent = "register" | "authenticate";

/**
 * Compose the opaque challenge key the passkey routes pass to the store. The
 * key binds the challenge to `subject + sessionId + intent` so a register
 * challenge cannot be replayed as an authenticate challenge (or across
 * sessions/subjects).
 */
export function passkeyChallengeKey(input: {
  subject: string;
  sessionId: string | null;
  intent: PasskeyChallengeIntent;
}): string {
  return `${input.intent}:${input.subject}:${input.sessionId ?? "anon"}`;
}
