import { describe, expect, test } from "bun:test";

import {
  capsuleRunTokenSecret,
  createCapsuleRunToken,
  isCapsuleRunToken,
  verifyCapsuleRunToken,
} from "../../../core/shared/capsule_run_tokens.ts";

const SECRET = "test-secret";
const BASE = {
  secret: SECRET,
  workspaceId: "ws_1",
  capsuleId: "cap_1",
  runId: "run_1",
};

describe("capsule run tokens", () => {
  test("round-trips a scoped token", async () => {
    const minted = await createCapsuleRunToken(BASE);
    expect(isCapsuleRunToken(minted.token)).toBe(true);
    const verified = await verifyCapsuleRunToken(minted.token, {
      secret: SECRET,
      expectedWorkspaceId: "ws_1",
      expectedCapsuleId: "cap_1",
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.sub).toBe("capsule:cap_1");
      expect(verified.payload.runId).toBe("run_1");
    }
  });

  test("rejects a wrong secret, scope mismatch, and expiry", async () => {
    const minted = await createCapsuleRunToken(BASE);
    expect(
      (await verifyCapsuleRunToken(minted.token, { secret: "other" })).ok,
    ).toBe(false);
    expect(
      (
        await verifyCapsuleRunToken(minted.token, {
          secret: SECRET,
          expectedCapsuleId: "cap_other",
        })
      ).ok,
    ).toBe(false);
    const expired = await createCapsuleRunToken({
      ...BASE,
      ttlSeconds: 60,
      now: () => Date.parse("2026-07-16T00:00:00.000Z"),
    });
    const verified = await verifyCapsuleRunToken(expired.token, {
      secret: SECRET,
      now: () => Date.parse("2026-07-16T00:02:00.000Z"),
    });
    expect(verified).toEqual({ ok: false, reason: "expired" });
  });

  test("never verifies a managed-provider token shape", async () => {
    expect(isCapsuleRunToken("takmpt_v1.abc.def")).toBe(false);
    const verified = await verifyCapsuleRunToken("takmpt_v1.abc.def", {
      secret: SECRET,
    });
    expect(verified.ok).toBe(false);
  });

  test("carries the mutability claim", async () => {
    const readOnly = await createCapsuleRunToken({ ...BASE, mutable: false });
    const mutable = await createCapsuleRunToken({ ...BASE, mutable: true });
    const ro = await verifyCapsuleRunToken(readOnly.token, { secret: SECRET });
    const rw = await verifyCapsuleRunToken(mutable.token, { secret: SECRET });
    expect(ro.ok && ro.payload.mutable).toBe(false);
    expect(rw.ok && rw.payload.mutable).toBe(true);
  });

  test("a signature is not cross-computable from raw HMAC over the payload", async () => {
    // Guards the domain-separation tag: a signature produced without the tag
    // (as another token family would) must not validate here.
    const minted = await createCapsuleRunToken(BASE);
    const [prefixAndFormat, payload] = minted.token
      .slice("takrun_".length)
      .split(".");
    void prefixAndFormat;
    const forgedInner = `v1.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(forgedInner),
      ),
    );
    const b64 = btoa(String.fromCharCode(...rawSig))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    const forged = `takrun_v1.${payload}.${b64}`;
    const verified = await verifyCapsuleRunToken(forged, { secret: SECRET });
    expect(verified.ok).toBe(false);
  });

  test("secret env prefers the dedicated knob with managed fallback", () => {
    expect(capsuleRunTokenSecret({ TAKOSUMI_RUN_TOKEN_SECRET: " a " })).toBe(
      "a",
    );
    expect(
      capsuleRunTokenSecret({
        TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "b",
      }),
    ).toBe("b");
    expect(capsuleRunTokenSecret({})).toBeUndefined();
  });
});
