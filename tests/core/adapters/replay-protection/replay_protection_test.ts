import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  InMemoryReplayProtectionStore,
  type ReplayProtectionMarkInput,
  type ReplayProtectionStore,
} from "../../../../core/adapters/replay-protection/mod.ts";

const baseInput: ReplayProtectionMarkInput = {
  namespace: "internal-request",
  requestId: "req_replay_basic",
  timestamp: Date.parse("2026-04-30T00:00:00.000Z"),
  expiresAt: Date.parse("2026-04-30T00:00:05.000Z"),
  seenAt: Date.parse("2026-04-30T00:00:00.500Z"),
};

test("InMemoryReplayProtectionStore admits a fresh request once and rejects replays", async () => {
  const store: ReplayProtectionStore = new InMemoryReplayProtectionStore();
  assert.equal(await store.markSeen(baseInput), true);
  assert.equal(await store.markSeen(baseInput), false);
});

test("InMemoryReplayProtectionStore evicts expired entries via cleanupExpired", async () => {
  const store: ReplayProtectionStore = new InMemoryReplayProtectionStore();
  assert.equal(await store.markSeen(baseInput), true);
  // Cleanup runs at a wall-clock past the expiry — the row must drop and
  // the same id must be re-admittable as a fresh request afterwards.
  await store.cleanupExpired(baseInput.expiresAt + 1);
  assert.equal(
    await store.markSeen({
      ...baseInput,
      seenAt: baseInput.expiresAt + 2,
    }),
    true,
  );
});
