/**
 * Review follow-ups for the Workspace-free Activity reads (TASK-0118 9.1):
 * one lookup budget per request, sealed keyset cursors (bound to the read
 * and the caller; unsealed keysets refused) that never reveal an event and
 * terminate at any number of rows per timestamp, a fail-closed host without
 * a passphrase, and a graceful partition cap.
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

  test("cursors are sealed: they name no event and cannot be read, forged or replayed under another key, read or account", async () => {
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
        // Only the server can open it, for this read and caller; the keyset
        // may be a hidden row.
        expect(await h.sealer!.open(cursor, { route: path.slice(1), subject: OWNER }), path).toBeDefined();
      }
      const [first] = cursors;
      // A flipped character fails authentication.
      const body = first!.slice(SEALED_ACTIVITY_CURSOR_PREFIX.length);
      const flipped = `${SEALED_ACTIVITY_CURSOR_PREFIX}${body[0] === "A" ? "B" : "A"}${body.slice(1)}`;
      const tampered = await h.get(`${path}?limit=1&cursor=${encodeURIComponent(flipped)}`, h.session(OWNER));
      expect(tampered.status, path).toBe(400);
      // A token sealed under another passphrase does not open here.
      const foreign = await createActivityCursorSealer(`${TEST_PASSPHRASE}-other`)
        .seal({ createdAt: NOW, id: "act_any" }, { route: path.slice(1), subject: OWNER });
      expect((await h.get(`${path}?limit=1&cursor=${encodeURIComponent(foreign)}`, h.session(OWNER))).status, path).toBe(400);
      // Another account cannot replay it.
      expect((await h.get(`/activity?limit=1&cursor=${encodeURIComponent(first!)}`, h.session(OTHER))).status, path).toBe(400);
    }
    // Nor can it move to another read.
    const fromAccount = (await h.get("/activity?limit=1", h.session(OWNER))).body.nextCursor!;
    expect((await h.get(`/capsules/${MINE}/activity?limit=1&cursor=${encodeURIComponent(fromAccount)}`, h.session(OWNER))).status).toBe(400);
    const fromApp = (await h.get(`/capsules/${MINE}/activity?limit=1`, h.session(OWNER))).body.nextCursor!;
    expect((await h.get(`/activity?limit=1&cursor=${encodeURIComponent(fromApp)}`, h.session(OWNER))).status).toBe(400);
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

  test("an unsealed keyset is refused, so a chosen position reveals nothing (review repro)", async () => {
    // The reviewer's oracle: with plain keysets accepted, "empty page with a
    // cursor" versus "a visible event" after a chosen (createdAt, id) let a
    // caller binary-search a hidden event's timestamp and then its id.
    for (const sealer of [undefined, null] as const) {
      const h = await fixture(sealer === null ? { sealer: null } : {});
      const secretId = "activity_capsule_initial_authority_cap_secret_42";
      await h.recordAt("act_v0", "2026-10-30T01:00:00.000Z", MINE);
      await h.recordAt("act_h1", "2026-10-30T01:00:01.000Z", THEIRS);
      await h.recordAt("act_h2", "2026-10-30T01:00:02.000Z", THEIRS);
      await h.recordAt("act_h3", "2026-10-30T01:00:03.000Z", THEIRS);
      await h.recordAt(secretId, "2026-10-30T01:00:04.123Z", THEIRS);
      await h.recordAt("act_v5", "2026-10-30T01:00:05.000Z", MINE);
      const probes = [
        { createdAt: "2026-10-30T01:00:04.124Z", id: "" },
        { createdAt: "2026-10-30T01:00:04.123Z", id: "" },
        { createdAt: "2026-10-30T01:00:04.123Z", id: "activity_" },
        { createdAt: "2026-10-30T01:00:04.123Z", id: `${secretId}\u0000` },
        { createdAt: "2026-10-30T01:00:02.000Z", id: "act_legacy" },
      ];
      for (const path of ["/activity", `/capsules/${MINE}/activity`]) {
        for (const probe of probes) {
          // Every chosen position gets the same answer, with or without a
          // passphrase on the host.
          const response = await h.get(`${path}?limit=1&cursor=${encodeCursor(probe)}`, h.session(OWNER));
          expect(response.status, `${path} ${probe.createdAt} ${probe.id}`).toBe(400);
          expect(response.body.events, path).toBeUndefined();
          expect(response.body.nextCursor, path).toBeUndefined();
        }
        // Positional and garbage cursors likewise.
        const positional = encodeCursor({ createdAt: "2026-10-30T01:00:02.000Z", id: "#k:1" });
        expect((await h.get(`${path}?cursor=${positional}`, h.session(OWNER))).status, path).toBe(400);
        expect((await h.get(`${path}?cursor=not-a-cursor`, h.session(OWNER))).status, path).toBe(400);
      }
    }
  });

  test("equal timestamps, hidden rows and budget stops page every visible event exactly once (review fuzz)", async () => {
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    for (let iteration = 0; iteration < 25; iteration++) {
      const h = await fixture();
      const expected: { id: string; createdAt: string }[] = [];
      const count = rand(60);
      for (let index = 0; index < count; index++) {
        const createdAt = `2026-10-30T01:00:0${rand(3)}.000Z`;
        const id = `act_f${String(iteration).padStart(2, "0")}_${String(index).padStart(3, "0")}`;
        const kind = rand(4);
        if (kind === 3) {
          // A Run event: attribution spends lookups; visible when the Run is mine.
          const runId = `run_f_${iteration}_${index}`;
          const mine = rand(2) === 0;
          h.runs.set(runId, { id: runId, workspaceId: WORKSPACE, capsuleId: mine ? MINE : THEIRS } as unknown as Run);
          await h.core.activity.recordIdempotent(id, createdAt, {
            workspaceId: WORKSPACE, action: "run.applied", targetType: "run", targetId: runId, metadata: {},
          });
          if (mine) expected.push({ id, createdAt });
        } else {
          await h.recordAt(id, createdAt, kind === 0 ? MINE : THEIRS);
          if (kind === 0) expected.push({ id, createdAt });
        }
      }
      expected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const limit = 1 + rand(5);
      for (const path of ["/activity", `/capsules/${MINE}/activity`]) {
        const { seen } = await drain(h, path, h.session(OWNER), limit);
        expect(seen.map((event) => event.id), `${iteration} ${path} limit=${limit}`).toEqual(expected.map((event) => event.id));
      }
    }
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
    const sealed = await createActivityCursorSealer(TEST_PASSPHRASE)
      .seal({ createdAt: NOW, id: "act_np_1" }, { route: "activity", subject: OWNER });
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
