/**
 * Review follow-ups for the Workspace-free Activity reads (TASK-0118 9.1):
 * one lookup budget per request, sealed keyset cursors that never reveal an
 * event and terminate at any number of rows per timestamp, a fail-closed host
 * without a passphrase, and a graceful partition cap.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Run } from "takosumi-contract/runs";
import { decodeCursor, encodeCursor } from "takosumi-contract/pagination";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import {
  createActivityCursorSealer,
  SEALED_ACTIVITY_CURSOR_PREFIX,
  type ActivityCursorSealer,
} from "../../../../accounts/service/src/control/activity-cursor.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const WORKSPACE = "ws_activity_paging";
const MINE = "cap_activity_mine";
const THEIRS = "cap_activity_theirs";
const OWNER = "user_test";
const OTHER = "acct_activity_other";
const NOW = "2026-10-30T00:00:00.000Z";
/** Test-only passphrase (not a secret); production derives from the secret store. */
const TEST_PASSPHRASE = "activity-cursor-test-passphrase-not-a-secret-0001";

async function fixture(options: {
  readonly extraPartitions?: number;
  /** `null`: a host without a secret-store passphrase. */
  readonly sealer?: ActivityCursorSealer | null;
} = {}) {
  const sealer = options.sealer === undefined ? createActivityCursorSealer(TEST_PASSPHRASE) : options.sealer;
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE, capsuleId: MINE, sourceId: "src_activity", snapshotId: "snap_activity", installConfigId: "cfg_activity",
  });
  await ledger.putCapsule({ ...seeded.capsule, status: "active", currentStateGeneration: 1, updatedAt: NOW });
  await ledger.putCapsule({ ...seeded.capsule, id: THEIRS, name: "theirs", slug: "theirs", status: "active", currentStateGeneration: 1, updatedAt: NOW });
  const extra: string[] = [];
  for (let index = 0; index < (options.extraPartitions ?? 0); index++) {
    const workspaceId = `ws_extra_${String(index).padStart(3, "0")}`;
    await ledger.putWorkspace({ ...seeded.workspace, id: workspaceId, handle: workspaceId.replaceAll("_", "-") });
    const capsuleId = `cap_extra_${String(index).padStart(3, "0")}`;
    await ledger.putCapsule({ ...seeded.capsule, id: capsuleId, name: capsuleId, slug: capsuleId, workspaceId, status: "active", currentStateGeneration: 1, updatedAt: NOW });
    extra.push(capsuleId);
  }
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" }, opentofuControlStore: ledger,
  });
  for (const [capsuleId, owner] of [[MINE, OWNER], [THEIRS, OTHER], ...extra.map((id) => [id, OWNER] as const)] as const) {
    expect(await core.appOwnership.initializeOwnershipIfMissing({
      capsuleId, ownerAccountId: owner, ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}`,
    })).toBe(true);
  }
  const runReads: string[] = [];
  const runs = new Map<string, Run>();
  const coreOperations = core as unknown as ControlPlaneOperations;
  const operations = {
    ...coreOperations,
    getRun: async (id: string) => {
      runReads.push(id);
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
  } as unknown as ControlPlaneOperations;
  const accounts = new InMemoryAccountsStore();
  for (const subject of [OWNER, OTHER]) accounts.saveAccount({ subject, createdAt: Date.now(), updatedAt: Date.now() });
  const session = (subject: string): Record<string, string> => {
    const sessionId = `sess_${subject}`;
    accounts.saveAccountSession({ sessionId, subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    return { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` };
  };
  async function get(path: string, credential: Record<string, string>) {
    const url = new URL(`${ORIGIN}/api/v1${path}`);
    const response = await handleControlRoute({
      request: new Request(url, { headers: credential }), url, store: accounts, operations,
      ...(sealer ? { activityCursorSealer: sealer } : {}),
    });
    return {
      status: response!.status,
      body: await response!.json() as { events?: ActivityEvent[]; nextCursor?: string; incomplete?: boolean; error?: unknown },
    };
  }
  async function record(event: Omit<ActivityEvent, "id" | "createdAt" | "workspaceId"> & { readonly workspaceId?: string }) {
    return await core.activity.record({ workspaceId: WORKSPACE, ...event });
  }
  async function recordAt(id: string, createdAt: string, capsuleId: string) {
    await core.activity.recordIdempotent(id, createdAt, {
      workspaceId: WORKSPACE, action: "capsule.updated", targetType: "capsule", targetId: capsuleId, metadata: {},
    });
  }
  return { core, runs, runReads, session, get, record, recordAt, extra, sealer };
}

async function drain(h: Awaited<ReturnType<typeof fixture>>, path: string, credential: Record<string, string>, limit: number) {
  const seen: ActivityEvent[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await h.get(`${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, credential);
    expect(response.status).toBe(200);
    seen.push(...response.body.events!);
    cursor = response.body.nextCursor;
    if (!cursor) return { seen, cursors };
    cursors.push(cursor);
  }
  throw new Error("cursor never terminated");
}

describe("Activity review follow-ups", () => {
  test("a request spends one lookup budget, and paging still returns every visible event", async () => {
    const h = await fixture();
    const expected: string[] = [];
    for (let index = 0; index < 120; index++) {
      // Each event names only a distinct Run: attribution needs a Run read.
      const runId = `run_paging_${String(index).padStart(3, "0")}`;
      h.runs.set(runId, { id: runId, workspaceId: WORKSPACE, capsuleId: index % 2 === 0 ? MINE : THEIRS } as unknown as Run);
      const event = await h.record({ action: "run.applied", targetType: "run", targetId: runId, metadata: {} });
      if (index % 2 === 0) expected.unshift(event!.id);
    }
    for (const path of ["/activity", `/capsules/${MINE}/activity`]) {
      h.runReads.length = 0;
      const first = await h.get(`${path}?limit=100`, h.session(OWNER));
      // At most one budget (50) of reads for the whole request.
      expect(new Set(h.runReads).size, path).toBeLessThanOrEqual(50);
      expect(first.body.nextCursor, path).toBeDefined();
      const all = await drain(h, path, h.session(OWNER), 100);
      expect(all.seen.map((event) => event.id), path).toEqual(expected);
    }
  });

  test("cursors are sealed: they name no event and cannot be read, forged or replayed under another key", async () => {
    const h = await fixture();
    const hidden = new Set<string>();
    for (let index = 0; index < 30; index++) {
      const mine = index % 10 === 0;
      const event = await h.record({ action: "capsule.updated", targetType: "capsule", targetId: mine ? MINE : THEIRS, metadata: { index } });
      if (!mine) hidden.add(event!.id);
    }
    for (const path of ["/activity", `/capsules/${MINE}/activity`]) {
      const { seen, cursors } = await drain(h, path, h.session(OWNER), 1);
      expect(seen.map((event) => event.metadata.index), path).toEqual([20, 10, 0]);
      expect(cursors.length, path).toBeGreaterThan(0);
      for (const cursor of cursors) {
        expect(cursor.startsWith(SEALED_ACTIVITY_CURSOR_PREFIX), path).toBe(true);
        // Not a readable keyset, and no hidden id appears in the token.
        expect(decodeCursor(cursor), path).toBeUndefined();
        for (const id of hidden) expect(cursor.includes(id), path).toBe(false);
        // Only the server can open it; the keyset may be a hidden row.
        expect(await h.sealer!.open(cursor), path).toBeDefined();
      }
      const [first] = cursors;
      // A flipped character fails authentication.
      const body = first!.slice(SEALED_ACTIVITY_CURSOR_PREFIX.length);
      const flipped = `${SEALED_ACTIVITY_CURSOR_PREFIX}${body[0] === "A" ? "B" : "A"}${body.slice(1)}`;
      const tampered = await h.get(`${path}?limit=1&cursor=${encodeURIComponent(flipped)}`, h.session(OWNER));
      expect(tampered.status, path).toBe(400);
      // A token sealed under another passphrase does not open here.
      const foreign = await createActivityCursorSealer(`${TEST_PASSPHRASE}-other`).seal({ createdAt: NOW, id: "act_any" });
      expect((await h.get(`${path}?limit=1&cursor=${encodeURIComponent(foreign)}`, h.session(OWNER))).status, path).toBe(400);
    }
  });

  test("events that share one timestamp page exactly once", async () => {
    const h = await fixture();
    const createdAt = "2026-10-30T01:00:00.000Z";
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const id = `act_same_${index}`;
      await h.recordAt(id, createdAt, index % 3 === 0 ? THEIRS : MINE);
      if (index % 3 !== 0) ids.push(id);
    }
    const { seen } = await drain(h, "/activity", h.session(OWNER), 2);
    expect(seen.map((event) => event.id)).toEqual([...ids].sort().reverse());
  });

  test("many rows at one timestamp with a small limit terminate (review repro)", async () => {
    const h = await fixture();
    const createdAt = "2026-10-30T01:00:00.000Z";
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      const id = `act_same_${index}`;
      await h.recordAt(id, createdAt, MINE);
      ids.push(id);
    }
    for (const path of ["/activity", `/capsules/${MINE}/activity`]) {
      const { seen } = await drain(h, path, h.session(OWNER), 1);
      expect(seen.map((event) => event.id), path).toEqual([...ids].sort().reverse());
    }
  });

  test("hidden rows at one timestamp beyond four store pages terminate (review repro)", async () => {
    const h = await fixture();
    const createdAt = "2026-10-30T01:00:00.000Z";
    for (let index = 0; index < 12; index++) {
      await h.recordAt(`act_h_${String(index).padStart(2, "0")}`, createdAt, index === 0 ? MINE : THEIRS);
    }
    for (const path of ["/activity", `/capsules/${MINE}/activity`]) {
      const { seen } = await drain(h, path, h.session(OWNER), 2);
      expect(seen.map((event) => event.id), path).toEqual(["act_h_00"]);
    }
  });

  test("a plain keyset cursor issued before sealing still continues after its row", async () => {
    const h = await fixture();
    for (let index = 0; index < 4; index++) {
      await h.recordAt(`act_legacy_${index}`, `2026-10-30T01:00:0${index}.000Z`, MINE);
    }
    const legacy = encodeCursor({ createdAt: "2026-10-30T01:00:02.000Z", id: "act_legacy_2" });
    const response = await h.get(`/activity?cursor=${legacy}`, h.session(OWNER));
    expect(response.status).toBe(200);
    expect(response.body.events!.map((event) => event.id)).toEqual(["act_legacy_1", "act_legacy_0"]);
    expect(response.body.nextCursor).toBeUndefined();
    // Positional cursors were never issued by a merged release: malformed.
    const positional = encodeCursor({ createdAt: "2026-10-30T01:00:02.000Z", id: "#k:1" });
    expect((await h.get(`/activity?cursor=${positional}`, h.session(OWNER))).status).toBe(400);
    expect((await h.get("/activity?cursor=not-a-cursor", h.session(OWNER))).status).toBe(400);
  });

  test("without a secret-store passphrase, paging fails closed and a single page still reads", async () => {
    const h = await fixture({ sealer: null });
    await h.recordAt("act_np_0", "2026-10-30T01:00:00.000Z", MINE);
    await h.recordAt("act_np_1", "2026-10-30T01:00:01.000Z", MINE);
    // Everything fits: no cursor is needed.
    const whole = await h.get("/activity", h.session(OWNER));
    expect(whole.status).toBe(200);
    expect(whole.body.events!.map((event) => event.id)).toEqual(["act_np_1", "act_np_0"]);
    // A page that would carry a cursor cannot seal it.
    for (const path of ["/activity?limit=1", `/capsules/${MINE}/activity?limit=1`]) {
      const paged = await h.get(path, h.session(OWNER));
      expect(paged.status, path).toBe(503);
      expect(JSON.stringify(paged.body), path).toContain("TAKOSUMI_SECRET_STORE_PASSPHRASE");
    }
    const sealed = await createActivityCursorSealer(TEST_PASSPHRASE).seal({ createdAt: NOW, id: "act_np_1" });
    expect((await h.get(`/activity?cursor=${encodeURIComponent(sealed)}`, h.session(OWNER))).status).toBe(503);
    // The dashboard feed reads one page and needs no cursor.
    const bootstrap = await h.get("/dashboard/bootstrap?includeNotifications=true", h.session(OWNER));
    expect(bootstrap.status).toBe(200);
  });

  test("more partitions than one request reads stays a 200 and says it is incomplete", async () => {
    const h = await fixture({ extraPartitions: 100 });
    await h.record({ action: "capsule.updated", targetType: "capsule", targetId: MINE, metadata: {} });
    const response = await h.get("/activity", h.session(OWNER));
    expect(response.status).toBe(200);
    expect(response.body.incomplete).toBe(true);
    const bootstrap = await h.get("/dashboard/bootstrap?includeNotifications=true", h.session(OWNER));
    expect(bootstrap.status).toBe(200);
    expect(await h.get("/activity", h.session(OTHER))).toMatchObject({ status: 200, body: { events: [] } });
    expect((await h.get("/activity", h.session(OTHER))).body.incomplete).toBeUndefined();
  });
});
