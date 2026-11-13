/** Private Accounts limits shared by the routes and durable adapters. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;
export const PASSKEY_CHALLENGE_WINDOW_MS = 60_000;
export const PASSKEY_CHALLENGES_PER_WINDOW = 120;
export const PASSKEY_CHALLENGE_SWEEP_MAX_ROWS = 64;
export const PASSKEY_SUBJECT_MAX_BYTES = 256;
export const PASSKEY_SESSION_MAX_BYTES = 512;

export interface PasskeyChallengeAdmissionInput {
  readonly key: string;
  readonly challenge: string;
  readonly now: number;
  readonly expiresAt: number;
  /** Private callers can narrow the fixed ceiling, never raise it. */
  readonly maxPerWindow?: number;
}

export interface PasskeyChallengeSweepInput {
  readonly now: number;
  readonly maxRows?: number;
}

export interface PasskeyChallengeSweepResult {
  readonly scanned: number;
  readonly deleted: number;
}

export function passkeyChallengeAdmissionPolicy(
  input: PasskeyChallengeAdmissionInput,
): { key: string; windowStart: number; expiresAt: number; limit: number } {
  const limit = input.maxPerWindow ?? PASSKEY_CHALLENGES_PER_WINDOW;
  if (
    !Number.isSafeInteger(input.now) || input.now < 0 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.now ||
    input.expiresAt > input.now + PASSKEY_CHALLENGE_TTL_MS ||
    !Number.isInteger(limit) || limit < 1 ||
    limit > PASSKEY_CHALLENGES_PER_WINDOW ||
    !/^passkey:v2:[0-9a-f]{64}$/.test(input.key) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)
  ) throw new TypeError("invalid passkey challenge admission");
  const start = passkeyChallengeWindowStart(input.now);
  return {
    key: `passkey:quota:v1:${start}`,
    windowStart: start,
    expiresAt: start + PASSKEY_CHALLENGE_WINDOW_MS,
    limit,
  };
}

export function passkeyChallengeWindowStart(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid passkey challenge time");
  return Math.floor(now / PASSKEY_CHALLENGE_WINDOW_MS) * PASSKEY_CHALLENGE_WINDOW_MS;
}

export function passkeyChallengeSweepLimit(
  input: PasskeyChallengeSweepInput,
): number {
  const limit = input.maxRows ?? PASSKEY_CHALLENGE_SWEEP_MAX_ROWS;
  if (
    !Number.isSafeInteger(input.now) || input.now < 0 ||
    !Number.isInteger(limit) || limit < 1 ||
    limit > PASSKEY_CHALLENGE_SWEEP_MAX_ROWS
  ) throw new TypeError("invalid passkey challenge sweep");
  return limit;
}

export function passkeyComponentWithinBytes(value: string, limit: number): boolean {
  return value.length <= limit && new TextEncoder().encode(value).byteLength <= limit;
}
