import { expect, test } from "bun:test";
import { assertEquals, assertThrows } from "../../../test/assert.ts";
import {
  InMemorySharedCellWarmPool,
  sharedCellRuntimeBinding,
} from "./runtime.ts";

test("sharedCellRuntimeBinding creates per-installation namespace targets", () => {
  const binding = sharedCellRuntimeBinding({
    installationId: "inst_1",
    cellId: "tokyo-cell-01",
    now: 1_000,
  });

  expect(binding.runtimeBindingId).toEqual("rtb_inst_1_shared_cell");
  expect(binding.mode).toEqual("shared-cell");
  expect(binding.targetType).toEqual("shared-cell");
  expect(binding.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_1");
});

test("InMemorySharedCellWarmPool allocates warm capacity once per installation", () => {
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 1 },
    { cellId: "tokyo-cell-02", capacity: 1 },
  ]);

  const first = pool.allocate({
    installationId: "inst_a",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    createdBySubject: "tsub_owner",
    now: 1_000,
  });
  const repeat = pool.allocate({
    installationId: "inst_a",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    createdBySubject: "tsub_owner",
    now: 2_000,
  });
  const second = pool.allocate({
    installationId: "inst_b",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    createdBySubject: "tsub_owner",
    now: 3_000,
  });
  const exhausted = pool.allocate({
    installationId: "inst_c",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    createdBySubject: "tsub_owner",
    now: 4_000,
  });

  expect(first?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_a");
  expect(repeat?.targetId).toEqual(first?.targetId);
  expect(second?.targetId).toEqual("shared-cell://tokyo-cell-02/namespaces/inst_b");
  expect(exhausted).toEqual(undefined);
  expect(pool.availableSlots()).toEqual([
    { cellId: "tokyo-cell-01", capacity: 0 },
    { cellId: "tokyo-cell-02", capacity: 0 },
  ]);
});

test("InMemorySharedCellWarmPool rejects unstable slot ids", () => {
  assertThrows(
    () =>
      new InMemorySharedCellWarmPool([{ cellId: "Tokyo Cell", capacity: 1 }]),
    TypeError,
    "cellId",
  );
  assertThrows(
    () =>
      new InMemorySharedCellWarmPool([{
        cellId: "tokyo-cell-01",
        capacity: 0,
      }]),
    TypeError,
    "capacity",
  );
});
