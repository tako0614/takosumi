/**
 * Sealed Activity cursors (TASK-0118 9.1): AES-256-GCM under an HKDF-SHA256
 * key from the secret-store passphrase, bound to the label, the read and the
 * caller, padded to a fixed size, and fail-closed when no passphrase is
 * configured.
 */
import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_CURSOR_LABEL,
  activityCursorSealerFromEnv,
  createActivityCursorSealer,
  SEALED_ACTIVITY_CURSOR_PREFIX,
} from "../../../../accounts/service/src/control/activity-cursor.ts";

/** Test-only passphrases (not secrets). */
const PASSPHRASE = "activity-cursor-test-passphrase-not-a-secret-0001";
const OTHER_PASSPHRASE = "activity-cursor-test-passphrase-not-a-secret-0002";
const POSITION = { createdAt: "2026-10-30T01:00:00.000Z", id: "act_hidden_0001" };
const CONTEXT = { route: "activity", subject: "tsub_reader" };

describe("sealed Activity cursors", () => {
  test("round-trips a keyset under a versioned prefix without revealing it", async () => {
    const sealer = createActivityCursorSealer(PASSPHRASE);
    const token = await sealer.seal(POSITION, CONTEXT);
    expect(ACTIVITY_CURSOR_LABEL).toBe("takosumi/activity-cursor/v1");
    expect(token.startsWith(SEALED_ACTIVITY_CURSOR_PREFIX)).toBe(true);
    expect(token.includes(POSITION.id)).toBe(false);
    expect(token.includes("2026-10-30")).toBe(false);
    expect(await sealer.open(token, CONTEXT)).toEqual(POSITION);
    // A fresh IV per seal: equal keysets do not produce equal tokens.
    expect(await sealer.seal(POSITION, CONTEXT)).not.toBe(token);
  });

  test("the token length does not depend on the id length", async () => {
    const sealer = createActivityCursorSealer(PASSPHRASE);
    const lengths = new Set<number>();
    for (const id of ["a", "act_0001", "activity_capsule_initial_authority_cap_secret_42", "x".repeat(300)]) {
      const token = await sealer.seal({ createdAt: POSITION.createdAt, id }, CONTEXT);
      lengths.add(token.length);
      expect(await sealer.open(token, CONTEXT)).toEqual({ createdAt: POSITION.createdAt, id });
    }
    expect(lengths.size).toBe(1);
  });

  test("opens only for the read and the caller it was issued to", async () => {
    const sealer = createActivityCursorSealer(PASSPHRASE);
    const token = await sealer.seal(POSITION, CONTEXT);
    expect(await sealer.open(token, { ...CONTEXT, route: "capsules/cap_a/activity" })).toBeUndefined();
    expect(await sealer.open(token, { ...CONTEXT, subject: "tsub_someone_else" })).toBeUndefined();
    expect(await sealer.open(token, CONTEXT)).toEqual(POSITION);
  });

  test("rejects tampered, truncated, foreign and unprefixed tokens", async () => {
    const sealer = createActivityCursorSealer(PASSPHRASE);
    const token = await sealer.seal(POSITION, CONTEXT);
    const body = token.slice(SEALED_ACTIVITY_CURSOR_PREFIX.length);
    // Index 20 starts a base64 quantum inside the ciphertext: every bit counts.
    const flipped = body[20] === "A" ? "B" : "A";
    expect(await sealer.open(`${SEALED_ACTIVITY_CURSOR_PREFIX}${body.slice(0, 20)}${flipped}${body.slice(21)}`, CONTEXT)).toBeUndefined();
    expect(await sealer.open(token.slice(0, SEALED_ACTIVITY_CURSOR_PREFIX.length + 20), CONTEXT)).toBeUndefined();
    expect(await sealer.open(body, CONTEXT)).toBeUndefined();
    expect(await sealer.open(`${SEALED_ACTIVITY_CURSOR_PREFIX}not*base64`, CONTEXT)).toBeUndefined();
    expect(await createActivityCursorSealer(OTHER_PASSPHRASE).open(token, CONTEXT)).toBeUndefined();
  });

  test("derives from the secret-store passphrase in the secret store's precedence", async () => {
    expect(activityCursorSealerFromEnv({})).toBeUndefined();
    expect(activityCursorSealerFromEnv({ TAKOSUMI_SECRET_STORE_PASSPHRASE: "too-short" })).toBeUndefined();
    expect(activityCursorSealerFromEnv({ TAKOSUMI_SECRET_STORE_PASSPHRASE: "   " })).toBeUndefined();
    const fromKey = activityCursorSealerFromEnv({ TAKOSUMI_SECRET_STORE_KEY: OTHER_PASSPHRASE })!;
    const both = activityCursorSealerFromEnv({
      TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
      TAKOSUMI_SECRET_STORE_KEY: OTHER_PASSPHRASE,
    })!;
    const token = await both.seal(POSITION, CONTEXT);
    // PASSPHRASE wins over KEY, and the env sealer matches a direct one.
    expect(await createActivityCursorSealer(PASSPHRASE).open(token, CONTEXT)).toEqual(POSITION);
    expect(await fromKey.open(token, CONTEXT)).toBeUndefined();
    expect(() => createActivityCursorSealer("too-short")).toThrow(RangeError);
  });
});
