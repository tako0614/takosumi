import { describe, expect, test } from "bun:test";

import {
  mintServiceScopedCredential,
  verifyServiceScopedCredential,
} from "../../../core/shared/service_scoped_credentials.ts";

const KEY = "shared-signing-key-abcdef0123456789";
const AUDIENCE = "storage.object";
const GIT_WIRE_FIXTURE =
  "tksvc_eyJ2IjoxLCJ3cyI6InNwYWNlX3dpcmUiLCJzdWIiOiJpbnN0X3dpcmUiLCJwZngiOiJzcGFjZV93aXJlIiwiY2FwIjpbInIiLCJ3Il0sImF1ZCI6InNvdXJjZS5naXQuc21hcnRfaHR0cCIsImlhdCI6MTc4MzgxNDQwMH0._g5nzwBAW-O9FoqlddOnzAbCRWvHo-RhfW-wUA0RDZk";

async function mint(
  overrides: Partial<Parameters<typeof mintServiceScopedCredential>[0]> = {},
) {
  return mintServiceScopedCredential({
    signingKey: KEY,
    workspaceId: "space_00112233aabbccdd",
    capsuleId: "inst_0011223344556677",
    prefix: "space_00112233aabbccdd/inst_0011223344556677/",
    verbs: ["r", "w", "l"],
    audience: AUDIENCE,
    now: () => 1_000_000_000_000,
    ...overrides,
  });
}

describe("service scoped credential", () => {
  test("keeps the Takos Git grant wire fixture stable", async () => {
    const { credential } = await mintServiceScopedCredential({
      signingKey: "wire-fixture-key",
      workspaceId: "space_wire",
      capsuleId: "inst_wire",
      prefix: "space_wire",
      verbs: ["r", "w"],
      audience: "source.git.smart_http",
      now: () => 1_783_814_400_000,
    });
    expect(credential).toBe(GIT_WIRE_FIXTURE);
  });

  test("mints a persistent tksvc_ credential with bounded authority", async () => {
    const { credential } = await mint();
    expect(credential.startsWith("tksvc_")).toBe(true);
    const result = await verifyServiceScopedCredential(
      KEY,
      credential,
      AUDIENCE,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.ws).toBe("space_00112233aabbccdd");
      expect(result.payload.sub).toBe("inst_0011223344556677");
      expect(result.payload.cap).toEqual(["r", "w", "l"]);
      expect(result.payload.pfx).toBe(
        "space_00112233aabbccdd/inst_0011223344556677/",
      );
      expect(result.payload).not.toHaveProperty("exp");
    }
  });

  test("rejects a different signing key or audience", async () => {
    const { credential } = await mint();
    expect(
      await verifyServiceScopedCredential("other-key", credential, AUDIENCE),
    ).toEqual({ ok: false, reason: "signature" });
    expect(
      await verifyServiceScopedCredential(KEY, credential, "other.service"),
    ).toEqual({ ok: false, reason: "version" });
  });

  test("rejects an empty prefix", async () => {
    const { credential } = await mint({ prefix: "" });
    expect(
      await verifyServiceScopedCredential(KEY, credential, AUDIENCE),
    ).toEqual({ ok: false, reason: "version" });
  });
});
