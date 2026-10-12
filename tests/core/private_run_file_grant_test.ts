import { expect, test } from "bun:test";
import {
  PartitionedSecretBoundaryCrypto,
  PlaceholderSecretBoundaryCrypto,
} from "../../core/adapters/secret-store/memory.ts";
import {
  createPrivateRunFileGrantCodec,
  PRIVATE_RUN_FILE_GRANT_MAX_TTL_MS,
  PrivateRunFileGrantError,
} from "../../core/domains/private-run-files/grant.ts";

const cryptoBoundary = new PartitionedSecretBoundaryCrypto({
  globalPassphrase: "test-only-private-run-file-grant-key-0123456789",
});
const scope = {
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  environment: "preview",
  slot: "opaque-1",
};
const authority = {
  runId: "run_1",
  executionAuthorityEpoch: 4,
  leaseToken: "lease-is-hidden",
};
let current = 1_000_000;
const codec = createPrivateRunFileGrantCodec({ cryptoBoundary, now: () => current });

test("sealed grant keeps lease opaque and binds exact scope, operations and expiry", async () => {
  current = 1_000_000;
  const token = await codec.mint({
    scope,
    authority,
    operations: ["read", "commit", "resolve"],
    expiresAt: current + 60_000,
  });
  expect(token.startsWith("prfg1.")).toBe(true);
  expect(token.includes(authority.leaseToken)).toBe(false);
  expect(token.includes(scope.capsuleId)).toBe(false);
  expect(await codec.open(token)).toEqual({
    scope,
    authority,
    operations: ["read", "commit", "resolve"],
    issuedAt: current,
    expiresAt: current + 60_000,
  });
  const altered = `${token.slice(0, -2)}${token.endsWith("A") ? "B" : "A"}${token.slice(-1)}`;
  await expect(codec.open(altered)).rejects.toBeInstanceOf(PrivateRunFileGrantError);
  current += 60_000;
  await expect(codec.open(token)).rejects.toBeInstanceOf(PrivateRunFileGrantError);
});

test("grant mint rejects unbounded or malformed authority and placeholder crypto", async () => {
  current = 2_000_000;
  const fallbackRun = await codec.mint({
    scope,
    authority,
    operations: ["read"],
    expiresAt: current + 960_000,
  });
  expect((await codec.open(fallbackRun)).expiresAt).toBe(current + 960_000);
  await expect(codec.mint({
    scope,
    authority,
    operations: ["read"],
    expiresAt: current + PRIVATE_RUN_FILE_GRANT_MAX_TTL_MS + 1,
  })).rejects.toBeInstanceOf(PrivateRunFileGrantError);
  await expect(codec.mint({
    scope,
    authority: { ...authority, executionAuthorityEpoch: 0 },
    operations: ["read"],
    expiresAt: current + 1000,
  })).rejects.toBeInstanceOf(PrivateRunFileGrantError);
  expect(() => createPrivateRunFileGrantCodec({
    cryptoBoundary: new PlaceholderSecretBoundaryCrypto() as PartitionedSecretBoundaryCrypto,
  })).toThrow(PrivateRunFileGrantError);
});
