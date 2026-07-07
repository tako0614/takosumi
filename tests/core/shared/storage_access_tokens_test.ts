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
      expect(result.payload.aud).toBe("takos.storage.workspace");
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
});
