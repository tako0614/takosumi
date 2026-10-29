import { afterEach, expect, test } from "bun:test";
import type { AppAccessResolver } from "../../../../contract/app-access.ts";
import type { Capsule } from "takosumi-contract/capsules";
import type { D1Like } from "../../../../core/adapters/storage/d1.ts";
import {
  D1AppAuthorizationStore,
  SqlAppAuthorizationStore,
  type AppAuthorizationMutations,
} from "../../../../core/domains/app-authorization/store.ts";
import {
  D1AppOwnershipStore,
  InMemoryAppOwnershipStore,
  SqlAppOwnershipStore,
  type AppOwnershipStore,
} from "../../../../core/domains/app-ownership/store.ts";
import {
  APP_PAYER_BOUNDARY_GUARD_MS as G,
  APP_PAYER_MAX_LATENESS_MS,
  appPayerAtEventTime,
  type AppOwnershipHistory,
  type CapsuleOwnershipTransferRow,
} from "../../../../core/domains/deploy-control/app_payer_history.ts";
import { BillingService } from "../../../../core/domains/deploy-control/billing_service.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { listPayerUsage, UsageReportingService } from "../../../../core/domains/deploy-control/usage_service.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const WS = "ws_transfer_payer";
const CREATED = "2026-10-01T00:00:00.000Z";
const A0 = "2026-10-23T00:00:00.000Z";
const MID = "2026-10-24T00:00:00.000Z";
const A1 = "2026-10-25T00:00:00.000Z";
const DRAIN = "2026-10-27T00:00:00.000Z";
const NOW = "2026-10-28T00:00:00.000Z";
const at = (iso: string, deltaMs: number) => new Date(Date.parse(iso) + deltaMs).toISOString();
const LATE = at(NOW, -APP_PAYER_MAX_LATENESS_MS - 1);

const clients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

interface Lane {
  readonly name: string;
  readonly control: OpenTofuControlStore;
  readonly ownership: AppOwnershipStore;
  insertTransfer(row: CapsuleOwnershipTransferRow): Promise<void>;
  readonly authorization?: AppAuthorizationMutations;
}

const emptyAccess: AppAccessResolver = {
  async resolveAppAccess() { return undefined; },
  async listAccessibleApps() { return { apps: [] }; },
};

async function lanes(): Promise<readonly Lane[]> {
  const memory = new InMemoryOpenTofuControlStore();
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const postgres = new SqlOpenTofuControlStore({ client: pg });
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const d1 = new CloudflareD1OpenTofuControlStore(db);
  const values = (row: CapsuleOwnershipTransferRow) => [row.id, row.capsuleId, row.fromAccountId, row.toAccountId,
    row.ownershipEpoch, row.drainManagementEpoch ?? null, row.state, row.createdAt, row.updatedAt];
  const result: Lane[] = [
    {
      name: "memory", control: memory, ownership: new InMemoryAppOwnershipStore(memory),
      insertTransfer: async (row) => memory.putCapsuleOwnershipTransfer(row),
    },
    {
      name: "postgres", control: postgres, ownership: new SqlAppOwnershipStore(pg, postgres),
      insertTransfer: async (row) => {
        await pg.query(`insert into takosumi_capsule_ownership_transfers
          (id,capsule_id,from_account_id,to_account_id,ownership_epoch,drain_management_epoch,state,created_at,updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, values(row));
      },
      authorization: new SqlAppAuthorizationStore(pg, emptyAccess),
    },
    {
      name: "d1", control: d1, ownership: new D1AppOwnershipStore(db, d1),
      insertTransfer: async (row) => {
        await db.prepare(`insert into capsule_ownership_transfers
          (id,capsule_id,from_account_id,to_account_id,ownership_epoch,drain_management_epoch,state,created_at,updated_at)
          values (?,?,?,?,?,?,?,?,?)`).bind(...values(row)).run();
      },
      authorization: new D1AppAuthorizationStore(db as unknown as D1Like, emptyAccess),
    },
  ];
  for (const lane of result) {
    await lane.control.putWorkspace({ id: WS, handle: "transfer-payer", displayName: "Transfer payer",
      type: "personal", ownerUserId: "workspace_owner", createdAt: CREATED, updatedAt: CREATED });
  }
  return result;
}

async function seedApp(lane: Lane, capsuleId: string, createdAt = CREATED): Promise<void> {
  const ownerAccountId = "first_owner";
  const capsule: Capsule = { id: capsuleId, workspaceId: WS, projectId: `prj_${capsuleId}`, name: capsuleId,
    slug: capsuleId, sourceId: `src_${capsuleId}`, installConfigId: `cfg_${capsuleId}`, environment: "production",
    currentStateGeneration: 0, status: "active", createdAt, updatedAt: createdAt };
  await lane.control.putCapsule(capsule);
  expect(await lane.ownership.initializeOwnershipIfMissing({ capsuleId, ownerAccountId, ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}` })).toBe(true);
}

async function setOwner(lane: Lane, capsuleId: string, ownerAccountId: string, ownershipEpoch: number,
  expectedOwnershipEpoch: number, management: { state: "active" | "draining"; epoch: number } = { state: "active", epoch: 0 }) {
  expect(await lane.ownership.putOwnership({ capsuleId, ownerAccountId, ownershipEpoch,
    managementState: management.state, managementEpoch: management.epoch, storageRoot: `apps/${capsuleId}` },
  expectedOwnershipEpoch)).toBe(true);
}

/** Ledger row plus the matching owner swap, as one accepted transfer writes them. */
async function transfer(lane: Lane, capsuleId: string, from: string, to: string, epoch: number, acceptedAt: string,
  row: Partial<CapsuleOwnershipTransferRow> = {}) {
  await lane.insertTransfer({ id: `${capsuleId}_accepted_${epoch}`, capsuleId, fromAccountId: from, toAccountId: to,
    ownershipEpoch: epoch, state: "accepted", createdAt: at(acceptedAt, -3_600_000), updatedAt: acceptedAt, ...row });
  await setOwner(lane, capsuleId, to, epoch + 1, epoch);
}

function meter(lane: Lane, now: () => number = () => Date.parse(NOW)) {
  let next = 0;
  const requireWorkspace = async (id: string) => (await lane.control.getWorkspace(id))!;
  const billing = new BillingService({ store: lane.control, now, newId: () => "unused",
    defaultBillingSettings: { mode: "showback" }, requireWorkspace });
  const service = new UsageReportingService({ store: lane.control, now, billing, requireWorkspace,
    newId: (prefix) => `${prefix}_${lane.name}_${++next}` });
  return async (capsuleId: string, createdAt?: string) => (await service.recordMeteredUsage(WS, {
    capsuleId, kind: "storage.gb_hour", quantity: 1, usdMicros: 0, ratingStatus: "unrated", source: "storage",
    idempotencyKey: `${capsuleId}:${++next}`, ...(createdAt ? { createdAt } : {}),
  })).usageEvent.payerAccountId;
}

const history = (input: Partial<AppOwnershipHistory> = {}): AppOwnershipHistory => ({
  ownerAccountId: "third", ownershipEpoch: 2,
  transfers: [
    { ownershipEpoch: 1, fromAccountId: "second", toAccountId: "third", acceptedAt: A1 },
    { ownershipEpoch: 0, fromAccountId: "first", toAccountId: "second", acceptedAt: A0 },
  ],
  ...input,
});
const event = (eventAt: string, recordedAt = NOW) =>
  ({ at: eventAt, recordedAt: Date.parse(recordedAt), appCreatedAt: CREATED });
const payer = (input: AppOwnershipHistory, eventAt: string) => appPayerAtEventTime(input, event(eventAt));

test("resolver attributes only usage spans that lie inside one ownership interval", () => {
  // Usage spans [T - G, min(T + G, recordedAt)]; a boundary inside it splits ownership.
  expect(payer(history(), at(A0, -G - 1))).toBe("first");
  expect(payer(history(), at(A0, -G))).toBeUndefined();
  expect(payer(history(), A0)).toBeUndefined();
  expect(payer(history(), at(A0, G - 1))).toBeUndefined();
  expect(payer(history(), at(A0, G))).toBe("second");
  expect(payer(history(), MID)).toBe("second");
  expect(payer(history(), at(A1, -G - 1))).toBe("second");
  expect(payer(history(), at(A1, G))).toBe("third");
  expect(payer(history(), NOW)).toBe("third");
  // Usage happens before its report reaches the server: the span ends at recordedAt.
  expect(payer(history(), at(NOW, G))).toBe("third");
  expect(payer(history(), at(NOW, G + 1))).toBeUndefined();
  // No usage precedes the app; the span starts no earlier than its creation.
  const initial = history({ ownerAccountId: "first", ownershipEpoch: 0, transfers: [] });
  expect(payer(initial, at(CREATED, -1))).toBeUndefined();
  expect(payer(initial, at(CREATED, 1))).toBe("first");
  // Bounded lateness applies only when the claim selects between owners.
  expect(payer(initial, LATE)).toBe("first");
  expect(payer(history(), LATE)).toBeUndefined();
  // A walk stopped one row past the span's interval still proves it and its start.
  const A2 = "2026-10-27T00:00:00.000Z";
  const stopped = history({ ownerAccountId: "fourth", ownershipEpoch: 3, transfers: [
    { ownershipEpoch: 2, fromAccountId: "third", toAccountId: "fourth", acceptedAt: A2 },
    history().transfers[0]!,
  ] });
  expect(payer(stopped, NOW)).toBe("fourth");
  expect(payer(stopped, at(A2, -G - 1))).toBeUndefined();
});

test("resolver refuses incomplete, ambiguous or unplaceable history", () => {
  const [newer, older] = history().transfers;
  for (const [label, input, eventAt] of [
    ["invalid event time", history(), "2026-10-26"],
    ["non-canonical event time", history(), "2026-10-26T00:00:00Z"],
    ["missing preceding boundary", history({ transfers: [newer] }), NOW],
    ["walk ends before epoch 0", history({ transfers: [newer] }), MID],
    ["epoch gap", history({ ownershipEpoch: 3 }), NOW],
    ["owner discontinuity", history({ ownerAccountId: "fourth" }), NOW],
    ["chain discontinuity", history({ transfers: [newer, { ...older, toAccountId: "other" }] }), NOW],
    ["duplicate epoch", history({ transfers: [newer, newer, older] }), NOW],
    ["self transfer", history({ transfers: [newer, { ...older, fromAccountId: "second" }] }), at(A0, -G - 1)],
    ["missing acceptance time", history({ transfers: [newer, { ...older, acceptedAt: "" }] }), NOW],
    ["non-canonical acceptance time", history({ transfers: [{ ...newer, acceptedAt: "2026-10-25 00:00:00" }, older] }), NOW],
    ["non-increasing acceptance time", history({ transfers: [newer, { ...older, acceptedAt: A1 }] }), NOW],
    ["draining current interval", history({ drainingTransferCreatedAt: DRAIN }), NOW],
    ["draining with unreadable creation", history({ drainingTransferCreatedAt: "" }), at(A1, G)],
    ["draining initial interval", history({ ownerAccountId: "first", ownershipEpoch: 0, transfers: [],
      drainingTransferCreatedAt: DRAIN }), NOW],
    ["missing owner", history({ ownerAccountId: "" }), NOW],
    ["invalid epoch", history({ ownershipEpoch: -1 }), NOW],
  ] as const) {
    expect({ label, payer: payer(input, eventAt) }).toEqual({ label, payer: undefined });
  }
  expect(appPayerAtEventTime(history(), { ...event(NOW), appCreatedAt: "not a time" })).toBeUndefined();
  // A drain leaves only usage that may reach its acceptance unknown.
  expect(payer(history({ drainingTransferCreatedAt: DRAIN }), MID)).toBe("second");
  expect(payer(history({ drainingTransferCreatedAt: DRAIN }), at(A1, G))).toBe("third");
  expect(payer(history({ drainingTransferCreatedAt: DRAIN }), at(DRAIN, -G - 1))).toBe("third");
  expect(payer(history({ drainingTransferCreatedAt: DRAIN }), at(DRAIN, -G))).toBeUndefined();
});

test("independent meters follow the accepted transfer ledger with memory/Postgres/D1 parity", async () => {
  for (const lane of await lanes()) {
    const record = meter(lane);
    await seedApp(lane, "cap_zero");
    // A never-transferred app has one owner for any placeable claim.
    expect([lane.name, await record("cap_zero"), await record("cap_zero", LATE),
      await record("cap_zero", at(CREATED, -1)), await record("cap_zero", at(NOW, G + 1))])
      .toEqual([lane.name, "first_owner", "first_owner", undefined, undefined]);

    await seedApp(lane, "cap_one");
    expect([lane.name, await record("cap_one")]).toEqual([lane.name, "first_owner"]);
    // Pending and cancelled rows are not payer history.
    await lane.insertTransfer({ id: "cap_one_cancelled", capsuleId: "cap_one", fromAccountId: "first_owner",
      toAccountId: "someone_else", ownershipEpoch: 0, state: "cancelled", createdAt: CREATED, updatedAt: at(A0, -60_000) });
    await transfer(lane, "cap_one", "first_owner", "second_owner", 0, A0);
    // A late report placed well before the acceptance stays with the old owner;
    // one whose usage span reaches the acceptance belongs to neither.
    expect([lane.name, await record("cap_one", at(A0, -G - 1)), await record("cap_one", at(A0, -G)),
      await record("cap_one", A0), await record("cap_one", at(A0, G)), await record("cap_one")])
      .toEqual([lane.name, "first_owner", undefined, undefined, "second_owner", "second_owner"]);
    expect([lane.name, await record("cap_one", at(NOW, G + 1)), await record("cap_one", LATE),
      await record("cap_one", at(CREATED, -1))]).toEqual([lane.name, undefined, undefined, undefined]);

    await seedApp(lane, "cap_two");
    await transfer(lane, "cap_two", "first_owner", "second_owner", 0, A0);
    await transfer(lane, "cap_two", "second_owner", "third_owner", 1, A1);
    expect([lane.name, await record("cap_two", at(A0, -G - 1)), await record("cap_two", at(A0, G)),
      await record("cap_two", MID), await record("cap_two", at(A1, -G - 1)), await record("cap_two", A1),
      await record("cap_two", at(A1, G)), await record("cap_two")])
      .toEqual([lane.name, "first_owner", "second_owner", "second_owner", "second_owner", undefined,
        "third_owner", "third_owner"]);

    const second = await listPayerUsage(lane.control, "second_owner");
    expect([lane.name, second.usageEvents.length]).toEqual([lane.name, 5]);
    expect([lane.name, second.usageEvents.every((row) => row.payerAccountId === "second_owner")]).toEqual([lane.name, true]);
  }
});

test("incomplete or ambiguous transfer history stays unattributed on memory/Postgres/D1", async () => {
  for (const lane of await lanes()) {
    const record = meter(lane);
    const unattributed = async (capsuleId: string, label: string) => {
      expect([lane.name, label, await record(capsuleId, at(A0, -G - 1)), await record(capsuleId, MID),
        await record(capsuleId)]).toEqual([lane.name, label, undefined, undefined, undefined]);
    };
    // An ownership change without its accepted ledger row.
    await seedApp(lane, "cap_no_row");
    await setOwner(lane, "cap_no_row", "second_owner", 1, 0);
    await unattributed("cap_no_row", "missing row");
    // Epoch 0 -> 1 is missing below a recorded epoch 1 -> 2 transfer.
    await seedApp(lane, "cap_gap");
    await setOwner(lane, "cap_gap", "second_owner", 1, 0);
    await transfer(lane, "cap_gap", "second_owner", "third_owner", 1, A1);
    await unattributed("cap_gap", "epoch gap");
    // The acceptance time is not a recorded canonical instant.
    await seedApp(lane, "cap_time");
    await transfer(lane, "cap_time", "first_owner", "second_owner", 0, A0, { updatedAt: "2026-10-23 00:00:00" });
    await unattributed("cap_time", "non-canonical acceptance time");
    await seedApp(lane, "cap_empty_time");
    await transfer(lane, "cap_empty_time", "first_owner", "second_owner", 0, A0, { updatedAt: "" });
    await unattributed("cap_empty_time", "missing acceptance time");
    // The newer acceptance is stamped before the older one.
    await seedApp(lane, "cap_order");
    await transfer(lane, "cap_order", "first_owner", "second_owner", 0, A1);
    await transfer(lane, "cap_order", "second_owner", "third_owner", 1, A0);
    expect([lane.name, await record("cap_order")]).toEqual([lane.name, undefined]);
    // The current owner is not the recipient of the latest accepted transfer.
    await seedApp(lane, "cap_owner");
    await transfer(lane, "cap_owner", "first_owner", "second_owner", 0, A0);
    await setOwner(lane, "cap_owner", "intruder", 2, 1);
    await unattributed("cap_owner", "owner discontinuity");
    // Two accepted rows end the same epoch.
    await seedApp(lane, "cap_duplicate");
    await transfer(lane, "cap_duplicate", "first_owner", "second_owner", 0, A0);
    await lane.insertTransfer({ id: "cap_duplicate_again", capsuleId: "cap_duplicate", fromAccountId: "first_owner",
      toAccountId: "second_owner", ownershipEpoch: 0, state: "accepted", createdAt: CREATED, updatedAt: at(A0, 1) });
    await unattributed("cap_duplicate", "duplicate epoch");
  }
});

test("a transfer drain leaves only usage that may reach its acceptance unattributed on memory/Postgres/D1", async () => {
  for (const lane of await lanes()) {
    const record = meter(lane);
    await seedApp(lane, "cap_drain");
    await transfer(lane, "cap_drain", "first_owner", "second_owner", 0, A0);
    await lane.insertTransfer({ id: "cap_drain_pending", capsuleId: "cap_drain", fromAccountId: "second_owner",
      toAccountId: "third_owner", ownershipEpoch: 1, state: "pending", createdAt: DRAIN, updatedAt: DRAIN });
    // A pending transfer that has not started draining does not move the boundary.
    expect([lane.name, await record("cap_drain")]).toEqual([lane.name, "second_owner"]);
    await lane.insertTransfer({ id: "cap_drain_other", capsuleId: "cap_other", fromAccountId: "x", toAccountId: "y",
      ownershipEpoch: 0, drainManagementEpoch: 3, state: "pending", createdAt: DRAIN, updatedAt: DRAIN });
    await setOwner(lane, "cap_drain", "second_owner", 1, 1, { state: "draining", epoch: 3 });
    // Draining for another reason (no transfer drain epoch) keeps attribution.
    expect([lane.name, await record("cap_drain")]).toEqual([lane.name, "second_owner"]);
  }
  for (const lane of await lanes()) {
    const record = meter(lane);
    await seedApp(lane, "cap_drain");
    await transfer(lane, "cap_drain", "first_owner", "second_owner", 0, A0);
    await lane.insertTransfer({ id: "cap_drain_pending", capsuleId: "cap_drain", fromAccountId: "second_owner",
      toAccountId: "third_owner", ownershipEpoch: 1, drainManagementEpoch: 3, state: "pending", createdAt: DRAIN, updatedAt: DRAIN });
    await setOwner(lane, "cap_drain", "second_owner", 1, 1, { state: "draining", epoch: 3 });
    // The pending acceptance is stamped after DRAIN: usage that ends before it
    // still belongs to the current owner.
    expect([lane.name, await record("cap_drain", at(A0, -G - 1)), await record("cap_drain", MID),
      await record("cap_drain", at(DRAIN, -G - 1)), await record("cap_drain", at(DRAIN, -G)), await record("cap_drain")])
      .toEqual([lane.name, "first_owner", "second_owner", "second_owner", undefined, undefined]);
  }
});

test("Postgres and D1 acceptance stamps the boundary later meters use", async () => {
  for (const lane of (await lanes()).filter((current) => current.authorization)) {
    const record = meter(lane, () => Date.now());
    await seedApp(lane, "cap_accept", "2020-01-01T00:00:00.000Z");
    const authorization = lane.authorization!;
    const { transferId } = await authorization.createTransfer({ capsuleId: "cap_accept", actorAccountId: "first_owner",
      toAccountId: "second_owner", expectedOwnershipEpoch: 0 });
    expect([lane.name, await record("cap_accept")]).toEqual([lane.name, "first_owner"]);
    const before = Date.now();
    expect((await authorization.acceptTransfer({ transferId, actorAccountId: "second_owner" })).state).toBe("accepted");
    const acceptedAt = (await lane.control.getAppOwnershipHistory("cap_accept", new Date().toISOString()))
      ?.transfers[0]?.acceptedAt;
    expect([lane.name, typeof acceptedAt === "string" && Date.parse(acceptedAt) >= before])
      .toEqual([lane.name, true]);
    // Live usage within G of the acceptance cannot be split between owners.
    expect([lane.name, await record("cap_accept", at(acceptedAt!, -G - 1)), await record("cap_accept"),
      await record("cap_accept", at(acceptedAt!, G))]).toEqual([lane.name, "first_owner", undefined, "second_owner"]);
  }
});
