/**
 * Tests for the StateVersion client functions on the session `/api/v1/*`
 * surface (Capsule detail GUI). Pure-logic tests in the same style
 * as `router-fallbacks_test.ts` / `views/graph/graph-layering_test.ts`,
 * runnable under `bun test`. They lock in the EXACT path + method each client fn
 * calls (so a drift from the server route contract in
 * accounts/service/src/control-routes.ts fails loudly) and the
 * public-only projection the read returns.
 *
 *   GET  /api/v1/capsules/:id/state-versions       -> { stateVersions: [...] }
 *   GET  /api/v1/state-versions/:id                -> { stateVersion: {...} }
 *   POST /api/v1/state-versions/:id/rollback-plan  -> { run: { id } }
 *
 * The rollback envelope is the public Run wrapper the existing `extractRunId`
 * reads, so the view can navigate to /runs/:id through the normal approve/apply
 * flow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createStateVersionRollbackPlan,
  extractRunId,
  getStateVersion,
  listStateVersions,
  listWorkspaceCurrentStateVersions,
  type PublicStateVersion,
} from "../../../../dashboard/src/lib/control-api.ts";

interface Captured {
  readonly url: string;
  readonly method: string;
}

const realFetch = globalThis.fetch;

/** Install a fetch stub that records the request and replies with `body`. */
function stubFetch(body: unknown, status = 200): () => Captured {
  let captured: Captured | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: typeof input === "string" ? input : String(input),
      method: (init?.method ?? "GET").toUpperCase(),
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    if (!captured) throw new Error("fetch was not called");
    return captured;
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const STATE_VERSION: PublicStateVersion = {
  id: "state_1",
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  environment: "production",
  generation: 3,
  createdByRunId: "run_apply_1",
  createdAt: "2026-06-09T00:00:00.000Z",
};

describe("listStateVersions", () => {
  test("GETs the Capsule StateVersion route and unwraps `stateVersions`", async () => {
    const captured = stubFetch({ stateVersions: [STATE_VERSION] });
    const rows = await listStateVersions("capsule 1");
    const req = captured();
    expect(req.method).toBe("GET");
    // The Capsule id is URL-encoded into the path.
    expect(req.url).toBe("/api/v1/capsules/capsule%201/state-versions");
    expect(rows).toEqual([STATE_VERSION]);
  });

  test("defaults to an empty list when the body omits `stateVersions`", async () => {
    stubFetch({});
    expect(await listStateVersions("capsule_1")).toEqual([]);
  });

  test("the projection never carries state storage or Output fields", async () => {
    stubFetch({ stateVersions: [STATE_VERSION] });
    const [row] = await listStateVersions("capsule_1");
    expect(row).toBeDefined();
    expect("objectKey" in (row as object)).toBe(false);
    expect("digest" in (row as object)).toBe(false);
    expect("outputsPublic" in (row as object)).toBe(false);
  });
});

describe("listWorkspaceCurrentStateVersions", () => {
  test("GETs the Workspace current-state-versions route and unwraps stateVersions", async () => {
    const captured = stubFetch({ stateVersions: [STATE_VERSION] });
    const rows = await listWorkspaceCurrentStateVersions("workspace 1", {
      includeDestroyed: false,
    });
    const req = captured();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "/api/v1/workspaces/workspace%201/current-state-versions?includeDestroyed=false",
    );
    expect(rows).toEqual([STATE_VERSION]);
  });

  test("defaults to an empty list when the body omits stateVersions", async () => {
    stubFetch({});
    expect(await listWorkspaceCurrentStateVersions("workspace_1")).toEqual([]);
  });
});

describe("getStateVersion", () => {
  test("GETs the stateVersion route and unwraps `stateVersion`", async () => {
    const captured = stubFetch({ stateVersion: STATE_VERSION });
    const got = await getStateVersion("state 1");
    const req = captured();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/v1/state-versions/state%201");
    expect(got).toEqual(STATE_VERSION);
  });
});

describe("createStateVersionRollbackPlan", () => {
  test("POSTs the rollback-plan route", async () => {
    const captured = stubFetch({ run: { id: "run_plan_rollback" } }, 201);
    const envelope = await createStateVersionRollbackPlan("state 1");
    const req = captured();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v1/state-versions/state%201/rollback-plan");
    // The envelope is the Run wrapper the run-id extractor understands, so
    // the view can navigate into the normal 変更を確認 → 承認 → 公開 flow.
    expect(extractRunId(envelope)).toBe("run_plan_rollback");
  });
});
