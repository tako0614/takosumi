import { describe, expect, test } from "bun:test";

import {
  mintStorageAccessToken,
  storageVerbsFromScopes,
  verifyStorageAccessToken,
} from "../../../core/shared/storage_access_tokens.ts";

const KEY = "shared-signing-key-abcdef0123456789";

async function mint(
  overrides: Partial<Parameters<typeof mintStorageAccessToken>[0]> = {},
) {
  return mintStorageAccessToken({
    signingKey: KEY,
    workspaceId: "space_00112233aabbccdd",
    installationId: "inst_0011223344556677",
    prefix: "space_00112233aabbccdd/inst_0011223344556677/",
    verbs: ["r", "w", "l"],
    now: () => 1_000_000_000_000,
    ...overrides,
  });
}

describe("storage access token", () => {
  test("mints a takstor_ token that verifies", async () => {
    const { token } = await mint();
    expect(token.startsWith("takstor_")).toBe(true);
    const result = await verifyStorageAccessToken(KEY, token, 1_000_000_100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.aud).toBe("takos.storage.object");
      expect(result.payload.cap).toEqual(["r", "w", "l"]);
      expect(result.payload.pfx).toBe(
        "space_00112233aabbccdd/inst_0011223344556677/",
      );
    }
  });

  test("rejects a token verified with a different key", async () => {
    const { token } = await mint();
    const result = await verifyStorageAccessToken(
      "other-key",
      token,
      1_000_000_100,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature");
  });

  test("expires past the TTL", async () => {
    const { token, ttlSeconds } = await mint({ ttlSeconds: 120 });
    expect(ttlSeconds).toBe(120);
    // now() = 1_000_000_000_000ms -> 1_000_000_000s; exp = +120
    const before = await verifyStorageAccessToken(KEY, token, 1_000_000_060);
    expect(before.ok).toBe(true);
    const after = await verifyStorageAccessToken(KEY, token, 1_000_000_200);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("expired");
  });

  test("clamps out-of-range TTL to the default", async () => {
    const { ttlSeconds } = await mint({ ttlSeconds: 999_999 });
    expect(ttlSeconds).toBe(900);
  });

  test("maps consume scopes to verbs", () => {
    expect(storageVerbsFromScopes(["files:read"])).toEqual(["r", "l"]);
    expect(storageVerbsFromScopes(["files:write"])).toEqual([
      "r",
      "w",
      "d",
      "l",
    ]);
    expect(storageVerbsFromScopes(["files:read", "files:write"])).toEqual([
      "r",
      "l",
      "w",
      "d",
    ]);
    // Unknown scopes fall back to read-only.
    expect(storageVerbsFromScopes([])).toEqual(["r", "l"]);
  });

  test("rejects a token with an empty prefix", async () => {
    const { token } = await mint({ prefix: "" });
    const result = await verifyStorageAccessToken(KEY, token, 1_000_000_100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("version");
  });

  // Frozen cross-repo vector — the SAME golden string asserted in
  // takos-storage/src/token.test.ts. Guards the byte-for-byte wire contract
  // against drift on either side.
  test("verifies its own golden vector (cross-repo anchor)", async () => {
    const GOLDEN =
      "takstor_eyJ2IjoxLCJ3cyI6InNwYWNlX2dvMWRnbzFkZ28xZGdvMWQiLCJzdWIiOiJpbnN0X2dvMWRnbzFkZ28xZGdvMWQiLCJwZngiOiJzcGFjZV9nbzFkZ28xZGdvMWRnbzFkL2luc3RfZ28xZGdvMWRnbzFkZ28xZC8iLCJjYXAiOlsiciIsInciLCJsIl0sImF1ZCI6InRha29zLnN0b3JhZ2Uub2JqZWN0IiwiaWF0IjoxMDAwMDAwMDAwLCJleHAiOjEwMDAwMDA5MDB9.dquD2sbJ1zPXqAp0FMCuUs8Mg_rV6BnKNr2mUvWaQhc";
    const result = await verifyStorageAccessToken(
      "golden-key-fixed-0123456789abcdef",
      GOLDEN,
      1_000_000_500,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.pfx).toBe(
        "space_go1dgo1dgo1dgo1d/inst_go1dgo1dgo1dgo1d/",
      );
      expect(result.payload.cap).toEqual(["r", "w", "l"]);
    }
  });
});
