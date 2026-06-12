/**
 * Tests for the Deployment client functions on the session `/api/v1/*`
 * surface (TASK Y — Installation 詳細 GUI). Pure-logic tests in the same style
 * as `router-fallbacks_test.ts` / `views/graph/graph-layering_test.ts`,
 * runnable under `bun test`. They lock in the EXACT path + method each client fn
 * calls (so a drift from the server route contract in
 * packages/accounts-service/src/control-routes.ts fails loudly) and the
 * public-only projection the read returns.
 *
 *   GET  /api/v1/installations/:id/deployments  -> { deployments: [...] }
 *   GET  /api/v1/deployments/:id                -> { deployment: {...} }
 *   POST /api/v1/deployments/:id/rollback-plan  -> { planRun: { id } }
 *
 * The rollback envelope is the plan-run wrapper the existing `extractRunId`
 * reads, so the view can navigate to /runs/:id through the normal approve/apply
 * flow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createDeploymentRollbackPlan,
  extractRunId,
  getDeployment,
  listDeployments,
  type PublicDeployment,
} from "./control-api.ts";

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

const DEPLOYMENT: PublicDeployment = {
  id: "dep_1",
  spaceId: "spc_1",
  installationId: "inst_1",
  environment: "production",
  applyRunId: "run_apply_1",
  sourceSnapshotId: "ss_1",
  stateGeneration: 3,
  outputsPublic: { launch_url: "https://example.com" },
  status: "active",
  createdAt: "2026-06-09T00:00:00.000Z",
};

describe("listDeployments", () => {
  test("GETs the installation deployments route and unwraps `deployments`", async () => {
    const captured = stubFetch({ deployments: [DEPLOYMENT] });
    const rows = await listDeployments("inst 1");
    const req = captured();
    expect(req.method).toBe("GET");
    // The installation id is URL-encoded into the path.
    expect(req.url).toBe("/api/v1/installations/inst%201/deployments");
    expect(rows).toEqual([DEPLOYMENT]);
  });

  test("defaults to an empty list when the body omits `deployments`", async () => {
    stubFetch({});
    expect(await listDeployments("inst_1")).toEqual([]);
  });

  test("the projection never carries an outputSnapshotId pointer", async () => {
    stubFetch({ deployments: [DEPLOYMENT] });
    const [row] = await listDeployments("inst_1");
    expect(row).toBeDefined();
    expect("outputSnapshotId" in (row as object)).toBe(false);
    // Only the allowlist-projected public outputs are present.
    expect(row?.outputsPublic).toEqual({ launch_url: "https://example.com" });
  });
});

describe("getDeployment", () => {
  test("GETs the deployment route and unwraps `deployment`", async () => {
    const captured = stubFetch({ deployment: DEPLOYMENT });
    const got = await getDeployment("dep 1");
    const req = captured();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/v1/deployments/dep%201");
    expect(got).toEqual(DEPLOYMENT);
  });
});

describe("createDeploymentRollbackPlan", () => {
  test("POSTs the rollback-plan route", async () => {
    const captured = stubFetch({ planRun: { id: "run_plan_rollback" } }, 201);
    const envelope = await createDeploymentRollbackPlan("dep 1");
    const req = captured();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v1/deployments/dep%201/rollback-plan");
    // The envelope is the plan-run wrapper the run-id extractor understands, so
    // the view can navigate into the normal 変更を確認 → 承認 → 公開 flow.
    expect(extractRunId(envelope)).toBe("run_plan_rollback");
  });
});
