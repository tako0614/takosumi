import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";

const origin = "https://takosumi.example.test";
const ref = "release/v2";
const plan = { id: "plan_revision", workspaceId: "ws_owned", capsuleId: "cap_owned", type: "plan", status: "succeeded",
  origin: { kind: "revision", ref }, policyStatus: "pass", baseStateGeneration: 1,
  planDigest: `sha256:${"a".repeat(64)}`, sourceSnapshotId: "snapshot_new",
  applyExpected: { currentStateVersionId: "state_old" }, summary: { add: 0, change: 1, destroy: 0 },
  planResources: [{ address: "example_resource.app", type: "example_resource", actions: ["update"] }] };
const revision = { id: "revision_one", workspaceId: "ws_owned", capsuleId: "cap_owned", operation: "revision",
  sourceSnapshotId: "snapshot_new", revision: { targetRef: ref, base: { capsuleStateGeneration: 1, capsuleStateVersionId: "state_old" } }, phase: "ready_for_review", generation: 3,
  planRunId: plan.id };
const capsule = { id: "cap_owned", workspaceId: "ws_owned", status: "active", currentStateGeneration: 1, currentStateVersionId: "state_old" };
const apply = { id: "apply_revision", workspaceId: "ws_owned", capsuleId: "cap_owned", type: "apply", planRunId: plan.id, status: "succeeded" };
const applyArgs = ["apps", "apply", "cap_owned", "--plan", plan.id, "--yes", "--token", "synthetic-account-pat", "--url", origin, "--json"];
const rollbackTarget = { id: "state_target", workspaceId: "ws_owned", capsuleId: "cap_owned", generation: 1, environment: "production" };
const rollbackPlan = { ...plan, id: "plan_rollback", baseStateGeneration: 2,
  origin: { kind: "rollback", stateVersionId: rollbackTarget.id }, applyExpected: { currentStateVersionId: "state_head" } };
const rollbackArgs = ["apps", "rollback", "cap_owned", "--state-version", rollbackTarget.id,
  "--idempotency-key=rollback=stable", "--token", "synthetic-account-pat", "--url", origin, "--json"];
const historyArgs = ["apps", "history", "cap_owned", "--token", "synthetic-account-pat", "--url", origin, "--json"];
const historyVersion = { ...rollbackTarget, createdAt: "2026-11-21T12:30:00.000Z", createdByRunId: "apply_first" };
const destroyPlan = { ...plan, id: "plan_destroy_recovery", type: "destroy_plan", status: "waiting_approval",
  origin: undefined, operation: "destroy", sourceSnapshotId: "snapshot_applied",
  summary: { add: 0, change: 0, destroy: 1 },
  planResources: [{ address: "example_resource.app", type: "example_resource", actions: ["delete"] }] };
const destroyApply = { ...apply, id: "apply_destroy_recovery", type: "destroy_apply",
  planRunId: destroyPlan.id, status: "succeeded" };
const destroyPairs = [
  { connectionId: "conn_old_a", replacementConnectionId: "conn_shared" },
  { connectionId: "conn_old_b", replacementConnectionId: "conn_shared" },
];
const recoverArgs = ["apps", "recover-uninstall", "cap_owned", "--connections", JSON.stringify(destroyPairs),
  "--token", "synthetic-account-pat", "--url", origin, "--json"];
const reviewDestroyArgs = ["apps", "recover-uninstall", "cap_owned", "--destroy-plan", destroyPlan.id,
  "--token", "synthetic-account-pat", "--url", origin, "--json"];
const destroyApplyArgs = ["apps", "apply", "cap_owned", "--destroy-plan", destroyPlan.id,
  "--yes", "--token", "synthetic-account-pat", "--url", origin, "--json"];

async function invoke(args: string[], handle: (req: Request) => Promise<Response> | Response) {
  const before = globalThis.fetch; const calls: Request[] = []; const out: string[] = []; const err: string[] = [];
  globalThis.fetch = (async (input, init) => { const req = new Request(input, init); calls.push(req); return await handle(req); }) as typeof fetch;
  try {
    const code = await main(args, { stdout: s => out.push(s), stderr: s => err.push(s) });
    return { code, calls, result: out.length ? JSON.parse(out.join("\n")) : undefined, err };
  } finally { globalThis.fetch = before; }
}

test("apps history reads one page and projects only app history fields", async () => {
  const cursor = "next/opaque+value=";
  const r = await invoke([...historyArgs, "--limit", "1"], req => {
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/api/v1/capsules/cap_owned/state-versions");
    expect(new URL(req.url).searchParams.get("limit")).toBe("1");
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-account-pat");
    return Response.json({ stateVersions: [{ ...historyVersion, stateRef: "private-artifact", digest: "private-digest" }], nextCursor: cursor });
  });
  expect(r.code).toBe(0);
  expect(r.calls).toHaveLength(1);
  expect(r.result).toEqual({ appId: "cap_owned", nextCursor: cursor, stateVersions: [{
    id: "state_target", generation: 1, environment: "production", createdAt: historyVersion.createdAt, createdByRunId: "apply_first",
  }] });
  const next = await invoke([...historyArgs, `--cursor=${r.result.nextCursor}`], req => {
    expect(new URL(req.url).searchParams.get("cursor")).toBe(cursor);
    return Response.json({ stateVersions: [] });
  });
  expect(next.calls).toHaveLength(1);
  expect(next.result).toEqual({ appId: "cap_owned", stateVersions: [] });
});

test("apps history refuses query mistakes and mismatched history without partial output", async () => {
  for (const args of [["--limit", "0"], ["--limit", "101"], ["--cursor", "with\ncontrol"], ["--yes"]]) {
    const result = await invoke([...historyArgs, ...args], () => { throw new Error("must not send HTTP"); });
    expect(result.code).toBe(2);
    expect(result.calls).toHaveLength(0);
  }
  const mismatch = await invoke(historyArgs, () => Response.json({
    stateVersions: [historyVersion, { ...historyVersion, capsuleId: "cap_other" }],
  }));
  expect(mismatch.code).toBe(1);
  expect(mismatch.result).toEqual({ status: "refused", appId: "cap_owned", code: "state_version_identity_mismatch" });
});

function normal(req: Request, overrides: { plan?: object; capsule?: object; history?: object; apply?: object } = {}) {
  const path = new URL(req.url).pathname;
  if (path === `/api/v1/runs/${plan.id}`) return Response.json({ run: overrides.plan ?? plan });
  if (path === "/api/v1/capsules/cap_owned") return Response.json({ capsule: overrides.capsule ?? capsule });
  if (path === "/api/v1/capsules/cap_owned/runs") {
    expect(new URL(req.url).searchParams.getAll("type")).toEqual(["apply"]);
    expect(new URL(req.url).searchParams.has("types")).toBe(false);
    return Response.json(overrides.history ?? { runs: [] });
  }
  if (path === `/api/v1/runs/${plan.id}/apply`) return Response.json({ run: overrides.apply ?? apply }, { status: 201 });
  if (path === `/api/v1/runs/${apply.id}`) return Response.json({ run: overrides.apply ?? apply });
  throw Error("unexpected fixture request");
}
function normalDestroy(req: Request, overrides: { plan?: object; capsule?: object; history?: object; apply?: object } = {}) {
  const path = new URL(req.url).pathname;
  if (path === `/api/v1/runs/${destroyPlan.id}`) return Response.json({ run: overrides.plan ?? destroyPlan });
  if (path === "/api/v1/capsules/cap_owned") return Response.json({ capsule: overrides.capsule ?? capsule });
  if (path === "/api/v1/capsules/cap_owned/runs") {
    expect(new URL(req.url).searchParams.getAll("type")).toEqual(["destroy_apply"]);
    expect(new URL(req.url).searchParams.has("types")).toBe(false);
    return Response.json(overrides.history ?? { runs: [] });
  }
  if (path === `/api/v1/runs/${destroyPlan.id}/apply`) return Response.json({ run: overrides.apply ?? destroyApply }, { status: 201 });
  if (path === `/api/v1/runs/${destroyApply.id}`) return Response.json({ run: overrides.apply ?? destroyApply });
  throw Error("unexpected Destroy fixture request");
}

test("apps update uses the Accounts revision coordinator and stops at explicit Plan review", async () => {
  const before = globalThis.fetch;
  const calls: Request[] = [];
  const out: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init); calls.push(req);
    const path = new URL(req.url).pathname;
    if (path.endsWith("/revision-plans")) return Response.json({ revisionPlan: revision, nextAction: "review_run", links: {} }, { status: 201 });
    if (path === `/api/v1/runs/${plan.id}`) return Response.json({ run: plan });
    throw Error("unexpected fixture request");
  }) as typeof fetch;
  try {
    expect(await main(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "fixed-update-key", "--url", origin,
      "--token", "synthetic-account-pat", "--json"], { stdout: s => out.push(s), stderr() {} })).toBe(0);
    expect(calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual(["/api/v1/capsules/cap_owned/revision-plans"]);
    expect(calls[0]!.redirect).toBe("error");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-account-pat");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("fixed-update-key");
    expect(await calls[0]!.json()).toEqual({ ref });
    expect(JSON.parse(out[0]!)).toMatchObject({ status: "review_required", appId: "cap_owned", planRunId: plan.id });
  } finally { globalThis.fetch = before; }
});

test("apps recover-uninstall creates one reviewed Destroy Plan with exact shared-target pairs", async () => {
  const r = await invoke(recoverArgs, req => {
    const path = new URL(req.url).pathname;
    if (path === "/api/v1/capsules/cap_owned/destroy-plan" && req.method === "POST")
      return Response.json({ run: destroyPlan }, { status: 201 });
    if (path === `/api/v1/runs/${destroyPlan.id}` && req.method === "GET")
      return Response.json({ run: destroyPlan });
    throw Error("unexpected recovery request");
  });
  expect(r.code).toBe(0);
  expect(r.result).toMatchObject({ status: "review_required", appId: "cap_owned",
    planRunId: destroyPlan.id, reviewUrl: `${origin}/runs/${destroyPlan.id}` });
  expect(r.calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname))
    .toEqual(["/api/v1/capsules/cap_owned/destroy-plan"]);
  expect(r.calls[0]!.redirect).toBe("error");
  expect(r.calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-account-pat");
  expect(await r.calls[0]!.json()).toEqual({ destroyProviderConnectionReplacements: destroyPairs });
});

test("recover-uninstall submits an explicit original Connection selection for review", async () => {
  const pairs = [
    { connectionId: "conn_old_a", replacementConnectionId: "conn_old_a" },
    { connectionId: "conn_old_b", replacementConnectionId: "conn_old_a" },
  ];
  const args = recoverArgs.map(value => value === JSON.stringify(destroyPairs) ? JSON.stringify(pairs) : value);
  const result = await invoke(args, () => Response.json({ run: destroyPlan }, { status: 201 }));
  expect(result.code).toBe(0);
  expect(result.calls.map(call => [call.method, new URL(call.url).pathname]))
    .toEqual([["POST", "/api/v1/capsules/cap_owned/destroy-plan"]]);
  expect(await result.calls[0]!.json()).toEqual({ destroyProviderConnectionReplacements: pairs });
  expect(result.result).toMatchObject({ status: "review_required", planRunId: destroyPlan.id });
});

test("recover-uninstall rejects malformed pairs and confirmation flags before HTTP", async () => {
  for (const pairs of [
    "not-json", "{}", "[]", "[{}]",
    JSON.stringify([destroyPairs[0], destroyPairs[0]]),
    JSON.stringify([{ ...destroyPairs[0], accountId: "account_claim" }]),
  ]) {
    const args = recoverArgs.map(s => s === JSON.stringify(destroyPairs) ? pairs : s);
    const r = await invoke(args, () => { throw Error("must not send recovery HTTP"); });
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
  }
  for (const args of [
    recoverArgs.filter((_, index) => index < 3 || index > 4),
    [...recoverArgs, "--yes"],
    [...recoverArgs, "--prepare"],
    [...reviewDestroyArgs, "--prepare"],
    [...recoverArgs.slice(0, 3), "--prepare", "--current-review"],
    [...recoverArgs, "--destroy-plan", destroyPlan.id],
    [...recoverArgs, "--current-review"],
    [...reviewDestroyArgs, "--current-review"],
    [...reviewDestroyArgs, "--yes"],
    reviewDestroyArgs.map(value => value === destroyPlan.id ? " " : value),
  ]) {
    const r = await invoke(args, () => { throw Error("must not send recovery HTTP"); });
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
  }
});

const currentReviewArgs = ["apps", "recover-uninstall", "cap_owned", "--current-review",
  "--token", "synthetic-account-pat", "--url", origin, "--json"];
const currentDestroyView = {
  kind: "takosumi.capsule-app@v1", capsuleId: destroyPlan.capsuleId, workspaceId: destroyPlan.workspaceId,
  status: "active", applied: true, latestRun: { id: destroyPlan.id, type: destroyPlan.type, status: destroyPlan.status },
  uninstall: { mode: "none" },
  progress: { revisionPreparing: false, review: { runId: destroyPlan.id, runType: "destroy_plan" } },
};

test("current uninstall review follows the app projection and rereads that exact Plan", async () => {
  const appRead = "/api/v1/capsules/cap_owned/app";
  const planRead = `/api/v1/runs/${destroyPlan.id}`;
  const r = await invoke(currentReviewArgs, req => {
    const url = new URL(req.url);
    expect(req.method).toBe("GET");
    expect(url.origin).toBe(origin);
    if (url.pathname === appRead) return Response.json({ app: currentDestroyView });
    if (url.pathname === planRead) return Response.json({ run: destroyPlan });
    throw Error("unexpected review request");
  });
  expect(r.code).toBe(0);
  expect(r.result).toMatchObject({ status: "review_required", planRunId: destroyPlan.id,
    reviewUrl: `${origin}/runs/${destroyPlan.id}`, plan: { id: destroyPlan.id, status: "waiting_approval" } });
  expect(r.calls.map(call => new URL(call.url).pathname)).toEqual([appRead, planRead, appRead]);
});

function pendingDestroyView(status: "queued" | "running") {
  const latestRun = { ...currentDestroyView.latestRun, status };
  return { ...currentDestroyView, latestRun, progress: { revisionPreparing: false, run: latestRun } };
}

test.each(["queued", "running"] as const)(
  "current uninstall recovery finds the same %s Plan without submitting another",
  async status => {
    const appRead = "/api/v1/capsules/cap_owned/app";
    const planRead = `/api/v1/runs/${destroyPlan.id}`;
    const r = await invoke(currentReviewArgs, req => new URL(req.url).pathname === appRead
      ? Response.json({ app: pendingDestroyView(status) })
      : Response.json({ run: { ...destroyPlan, status } }));
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({
      status: "plan_pending", planRunId: destroyPlan.id, planStatus: status,
      reviewUrl: `${origin}/runs/${destroyPlan.id}`,
    });
    expect(r.result.plan).toBeUndefined();
    expect(r.calls.map(call => [call.method, new URL(call.url).pathname]))
      .toEqual([["GET", appRead], ["GET", planRead], ["GET", appRead]]);
  },
);

test("current uninstall recovery returns the review when the same pending Plan finishes", async () => {
  let firstAppRead = true;
  const r = await invoke(currentReviewArgs, req => {
    if (!new URL(req.url).pathname.endsWith("/app")) return Response.json({ run: destroyPlan });
    const app = firstAppRead ? pendingDestroyView("running") : currentDestroyView;
    firstAppRead = false;
    return Response.json({ app });
  });
  expect(r.code).toBe(0);
  expect(r.result).toMatchObject({ status: "review_required", planRunId: destroyPlan.id });
  expect(r.calls.map(call => call.method)).toEqual(["GET", "GET", "GET"]);
});

test.each([false, true])(
  "current uninstall recovery rechecks the same Plan when the app view advances after the Run read (superseded: %s)",
  async superseded => {
    const appRead = "/api/v1/capsules/cap_owned/app";
    const planRead = `/api/v1/runs/${destroyPlan.id}`;
    let appReads = 0;
    let planReads = 0;
    const r = await invoke(currentReviewArgs, req => {
      if (new URL(req.url).pathname === appRead) {
        appReads += 1;
        if (appReads === 1) return Response.json({ app: pendingDestroyView("running") });
        if (appReads === 3 && superseded) {
          return Response.json({ app: {
            ...currentDestroyView,
            latestRun: { ...currentDestroyView.latestRun, id: "other_review" },
            progress: { ...currentDestroyView.progress, review: { runId: "other_review", runType: "destroy_plan" } },
          } });
        }
        return Response.json({ app: currentDestroyView });
      }
      planReads += 1;
      return Response.json({ run: planReads === 1 ? { ...destroyPlan, status: "running" } : destroyPlan });
    });
    expect(r.calls.map(call => [call.method, new URL(call.url).pathname])).toEqual([
      ["GET", appRead], ["GET", planRead], ["GET", appRead], ["GET", planRead], ["GET", appRead],
    ]);
    if (superseded) {
      expect(r.code).toBe(1);
      expect(r.result).toMatchObject({ status: "refused", code: "current_destroy_review_unavailable" });
      expect(r.result.planRunId).toBeUndefined();
    } else {
      expect(r.code).toBe(0);
      expect(r.result).toMatchObject({ status: "review_required", planRunId: destroyPlan.id });
    }
  },
);

test("current uninstall recovery rereads a Plan that failed after the detail read", async () => {
  const errorCode = "provider_credential_env_conflict";
  const running = pendingDestroyView("running");
  const failed = {
    ...running, latestRun: { ...running.latestRun, status: "failed" },
    progress: { revisionPreparing: false },
  };
  const appRead = "/api/v1/capsules/cap_owned/app";
  const planRead = `/api/v1/runs/${destroyPlan.id}`;
  let appReads = 0;
  let planReads = 0;
  const result = await invoke(currentReviewArgs, request => {
    switch (new URL(request.url).pathname) {
      case appRead: return Response.json({ app: appReads++ === 0 ? running : failed });
      case planRead: return Response.json({ run: planReads++ === 0
        ? { ...destroyPlan, status: "running" }
        : { ...destroyPlan, status: "failed", errorCode },
      });
      default: throw new Error("unexpected review request");
    }
  });
  expect(result.code).toBe(1);
  expect(result.result).toMatchObject({
    status: "failed", planRunId: destroyPlan.id, planStatus: "failed", code: errorCode,
  });
  expect(result.result.plan).toBeUndefined();
  expect(result.calls.map(call => [call.method, new URL(call.url).pathname])).toEqual(
    [appRead, planRead, appRead, planRead, appRead].map(path => ["GET", path]),
  );
});

test.each(["unreported failure", "finalizer", "rescheduled during read"] as const)(
  "current uninstall recovery refuses a failed Plan outside the current reservation (%s)",
  async scenario => {
    const appPath = "/api/v1/capsules/cap_owned";
    const scheduled = {
      phase: "scheduled", requestedAt: "2026-11-21T12:30:00.000Z",
      deleteAfter: "2026-11-28T12:30:00.000Z",
    };
    const app = {
      ...currentDestroyView, status: "uninstalled", uninstall: { scheduled },
      latestRun: { ...currentDestroyView.latestRun, status: "failed" },
      progress: { revisionPreparing: false },
      problems: scenario === "unreported failure" ? [] : [
        { code: "uninstall_failed", runId: destroyPlan.id, runType: "destroy_plan" },
      ],
    };
    let appReads = 0;
    const result = await invoke(currentReviewArgs, request => {
      switch (new URL(request.url).pathname) {
        case `${appPath}/app`: return Response.json({ app:
          appReads++ === 0 ? app : {
            ...app, uninstall: { scheduled: { ...scheduled, requestedAt: "2026-11-21T12:31:00.000Z" } },
          },
        });
        case appPath: return Response.json({ capsule: {
          id: app.capsuleId, workspaceId: app.workspaceId, status: app.status,
          uninstall: {
            phase: scheduled.phase, requestedAt: scheduled.requestedAt, scheduledDestroyAt: scheduled.deleteAfter,
            destroyPlanRunId: scenario === "finalizer" ? destroyPlan.id : "other_finalizer",
          },
        } });
        case `/api/v1/runs/${destroyPlan.id}`: return Response.json({ run: { ...destroyPlan, status: "failed" } });
        default: throw new Error("unexpected review request");
      }
    });
    expect(result.code).toBe(1);
    expect(result.result).toMatchObject({ status: "refused", code: "current_destroy_review_unavailable" });
    expect(result.result.planRunId).toBeUndefined();
    const expected = [`${appPath}/app`];
    if (scenario !== "unreported failure") expected.push(appPath);
    if (scenario === "rescheduled during read") {
      expected.push(`/api/v1/runs/${destroyPlan.id}`, `${appPath}/app`);
    }
    expect(result.calls.map(call => [call.method, new URL(call.url).pathname])).toEqual(
      expected.map(path => ["GET", path]),
    );
  },
);

test.each(["scheduled", "destroying"] as const)(
  "current uninstall recovery distinguishes a pending manual Plan during the %s phase",
  async phase => {
    const app = {
      ...pendingDestroyView("running"), status: "uninstalled",
      uninstall: { scheduled: { phase } },
    };
    for (const finalizerId of [destroyPlan.id, "scheduled_plan"]) {
      const r = await invoke(currentReviewArgs, req => {
        switch (new URL(req.url).pathname) {
          case "/api/v1/capsules/cap_owned/app": return Response.json({ app });
          case "/api/v1/capsules/cap_owned": return Response.json({ capsule: {
            id: app.capsuleId, workspaceId: app.workspaceId, status: "uninstalled",
            uninstall: { phase, destroyPlanRunId: finalizerId },
          } });
          case `/api/v1/runs/${destroyPlan.id}`:
            return Response.json({ run: { ...destroyPlan, status: "running" } });
          default: throw Error("unexpected review request");
        }
      });
      expect(r.calls.every(call => call.method === "GET")).toBe(true);
      if (finalizerId === destroyPlan.id) {
        expect(r.code).toBe(1);
        expect(r.result).toMatchObject({ status: "refused", code: "current_destroy_review_unavailable" });
        expect(r.result.planRunId).toBeUndefined();
        expect(r.calls).toHaveLength(2);
      } else {
        expect(r.code).toBe(0);
        expect(r.result).toMatchObject({ status: "plan_pending", planRunId: destroyPlan.id });
        expect(r.calls).toHaveLength(4);
      }
    }
  },
);

test("current uninstall recovery refuses an ambiguous source-less Plan while the reservation can replace its ID", async () => {
  const app = {
    ...pendingDestroyView("running"), status: "uninstalled",
    uninstall: { scheduled: { phase: "scheduled" } },
  };
  const r = await invoke(currentReviewArgs, req => {
    switch (new URL(req.url).pathname) {
      case "/api/v1/capsules/cap_owned/app": return Response.json({ app });
      case "/api/v1/capsules/cap_owned": return Response.json({ capsule: {
        id: app.capsuleId, workspaceId: app.workspaceId, status: "uninstalled",
        uninstall: { phase: "scheduled", destroyPlanRunId: "reserved_scheduled_plan" },
      } });
      case `/api/v1/runs/${destroyPlan.id}`: return Response.json({ run: {
        ...destroyPlan, status: "running", sourceSnapshotId: undefined,
      } });
      default: throw Error("unexpected review request");
    }
  });
  expect(r.code).toBe(1);
  expect(r.result).toMatchObject({ status: "refused", code: "current_destroy_review_unavailable" });
  expect(r.result.planRunId).toBeUndefined();
  expect(r.calls.map(call => call.method)).toEqual(["GET", "GET", "GET"]);
});

test("current uninstall review distinguishes a manual Plan from an originless scheduled finalizer", async () => {
  const app = {
    ...currentDestroyView, status: "uninstalled",
    uninstall: { scheduled: { phase: "destroying" } },
  };
  for (const finalizerId of [destroyPlan.id, "previous_scheduled_destroy"]) {
    const result = await invoke(currentReviewArgs, req => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/app")) return Response.json({ app });
      if (path === "/api/v1/capsules/cap_owned") return Response.json({ capsule: {
        id: app.capsuleId, workspaceId: app.workspaceId, status: "uninstalled",
        uninstall: { phase: "destroying", destroyPlanRunId: finalizerId },
      } });
      return Response.json({ run: destroyPlan });
    });
    expect(result.calls.every(call => call.method === "GET")).toBe(true);
    if (finalizerId === destroyPlan.id) {
      expect(result.code).toBe(1);
      expect(result.result).toMatchObject({ code: "current_destroy_review_unavailable" });
      expect(result.calls.map(call => new URL(call.url).pathname))
        .toEqual(["/api/v1/capsules/cap_owned/app", "/api/v1/capsules/cap_owned"]);
    } else {
      expect(result.code).toBe(0);
      expect(result.result).toMatchObject({ status: "review_required", planRunId: destroyPlan.id });
    }
  }
});

test("current uninstall review refuses a Plan superseded during its detail read", async () => {
  let detailRead = false;
  const r = await invoke(currentReviewArgs, req => {
    if (!new URL(req.url).pathname.endsWith("/app")) {
      detailRead = true;
      return Response.json({ run: destroyPlan });
    }
    return Response.json({ app: detailRead
      ? { ...currentDestroyView, latestRun: destroyApply, progress: { revisionPreparing: false, run: destroyApply } }
      : currentDestroyView });
  });
  expect(r.code).toBe(1);
  expect(r.result).toMatchObject({ status: "refused", code: "current_destroy_review_unavailable" });
  expect(r.result.planRunId).toBeUndefined();
  expect(r.calls.map(call => call.method)).toEqual(["GET", "GET", "GET"]);
});

test("current uninstall review refuses an unavailable, stale, or scheduled removal", async () => {
  const view = currentDestroyView;
  for (const app of [
    { ...view, capsuleId: "another_app" },
    { ...view, applied: false },
    { ...view, status: "destroyed" },
    { ...view, progress: { ...view.progress, revisionPreparing: true } },
    { ...view, progress: { ...view.progress, run: destroyApply } },
    { ...view, latestRun: { ...view.latestRun, id: "later_review" } },
    { ...view, latestRun: { ...view.latestRun, status: "failed" } },
    {
      ...pendingDestroyView("running"),
      latestRun: { ...view.latestRun, status: "failed" },
    },
  ]) {
    const r = await invoke(currentReviewArgs, () => Response.json({ app }));
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ status: "refused", code: "current_destroy_review_unavailable" });
    expect(r.calls.map(call => call.method)).toEqual(["GET"]);
  }
  for (const response of [
    () => Response.json({ run: { ...destroyPlan, workspaceId: "other_workspace" } }),
    () => Response.json({ run: { ...destroyPlan, status: "failed" } }),
    () => Response.json({ run: { ...destroyPlan, origin: { kind: "scheduled_uninstall", uninstallId: "scheduled" } } }),
    () => Response.json({ error: { code: "forbidden" } }, { status: 403 }),
  ]) {
    const r = await invoke(currentReviewArgs, req => new URL(req.url).pathname.endsWith("/app")
      ? Response.json({ app: currentDestroyView }) : response());
    expect(r.code).toBe(1);
    expect(r.result.status).toBe("refused");
    expect(r.result.planRunId).toBeUndefined();
    expect(r.calls.map(call => call.method)).toEqual(["GET", "GET"]);
  }
});

test("recovery Plan submission with a lost response sends only the original request", async () => {
  const r = await invoke(recoverArgs, () => { throw Error("lost synthetic Plan response"); });
  expect(r.code).toBe(1);
  expect(r.result).toMatchObject({ status: "unconfirmed", appId: "cap_owned" });
  expect(r.result.recovery).toContain("Run history");
  expect(r.calls.map(c => [c.method, new URL(c.url).pathname]))
    .toEqual([["POST", "/api/v1/capsules/cap_owned/destroy-plan"]]);
});

test("a Destroy Plan save timeout leaves the replacement unconfirmed without resubmitting", async () => {
  const respond = (stage: string, reservedPlanRunId?: unknown) => Response.json({ error: {
    code: "failed_precondition",
    details: { reason: "capsule_plan_creation_timeout", stage, timeoutMs: 25_000, reservedPlanRunId },
  } }, { status: 409 });

  const reservedPlanRunId = "plan_0123456789abcdef";
  const saving = await invoke(recoverArgs, () => respond("plan_run_create", reservedPlanRunId));
  expect(saving.code).toBe(1);
  expect(saving.result).toMatchObject({
    status: "unconfirmed", appId: "cap_owned", code: "failed_precondition", reservedPlanRunId,
  });
  expect(saving.result.planRunId).toBeUndefined();
  expect(saving.result.recovery).toContain(`--destroy-plan ${reservedPlanRunId}`);
  expect(saving.result.recovery).toContain("the save is still unconfirmed");
  expect(saving.calls.map(c => [c.method, new URL(c.url).pathname]))
    .toEqual([["POST", "/api/v1/capsules/cap_owned/destroy-plan"]]);

  for (const id of [undefined, "plan_$(not-an-id)", "apply_0123456789abcdef", 7]) {
    const fallback = await invoke(recoverArgs, () => respond("plan_run_create", id));
    expect(fallback.code).toBe(1);
    expect(fallback.result.status).toBe("unconfirmed");
    expect(fallback.result.reservedPlanRunId).toBeUndefined();
    expect(fallback.result.recovery).toContain("--current-review");
    expect(fallback.calls.map(c => c.method)).toEqual(["POST"]);
  }

  const beforeSaving = await invoke(recoverArgs, () => respond("capsule_load", reservedPlanRunId));
  expect(beforeSaving.code).toBe(1);
  expect(beforeSaving.result.status).toBe("refused");
  expect(beforeSaving.result.reservedPlanRunId).toBeUndefined();
  expect(beforeSaving.calls.map(c => c.method)).toEqual(["POST"]);
});

test("recover-uninstall distinguishes confirmed replacement connection refusals", async () => {
  for (const connectionRecoveryFailure of [
    "replacement_unverified", "replacement_auth_mode_mismatch", "bindings_mismatch", "applied_evidence_unavailable",
  ]) {
    const r = await invoke(recoverArgs, () => Response.json({ error: {
      code: "failed_precondition",
      message: "synthetic-private-server-message",
      details: {
        reason: "destroy_connection_recovery_unproven",
        connectionRecoveryFailure,
        privateEvidence: "synthetic-private-evidence",
      },
    } }, { status: 409 }));
    expect(r.code).toBe(1);
    expect(r.result).toEqual({
      status: "refused", appId: "cap_owned", code: "failed_precondition", connectionRecoveryFailure,
    });
    expect(r.err).toEqual([]);
    expect(r.calls.map(c => [c.method, new URL(c.url).pathname]))
      .toEqual([["POST", "/api/v1/capsules/cap_owned/destroy-plan"]]);
  }
});

test("recover-uninstall does not infer a diagnosis from a legacy, unknown or unrelated refusal", async () => {
  for (const [status, code, reason, failure] of [
    [409, "failed_precondition", "destroy_connection_recovery_unproven", undefined],
    [409, "failed_precondition", "destroy_connection_recovery_unproven", "synthetic-private-detail"],
    [409, "failed_precondition", "another_refusal", "bindings_mismatch"],
    [409, "conflict", "destroy_connection_recovery_unproven", "bindings_mismatch"],
    [503, "failed_precondition", "destroy_connection_recovery_unproven", "bindings_mismatch"],
  ] as const) {
    const r = await invoke(recoverArgs, () => Response.json({ error: {
      code, details: { reason, connectionRecoveryFailure: failure },
    } }, { status }));
    expect(r.code).toBe(1);
    expect(r.result.status).toBe(status === 503 ? "unconfirmed" : "refused");
    expect(r.result).not.toHaveProperty("connectionRecoveryFailure");
    if (status === 503) expect(r.result.recovery).toContain("Run history");
    expect(r.calls.map(c => c.method)).toEqual(["POST"]);
  }

  const unrelatedRead = await invoke(reviewDestroyArgs, () => Response.json({ error: {
    code: "failed_precondition",
    details: {
      reason: "destroy_connection_recovery_unproven",
      connectionRecoveryFailure: "bindings_mismatch",
    },
  } }, { status: 409 }));
  expect(unrelatedRead.code).toBe(1);
  expect(unrelatedRead.result).not.toHaveProperty("connectionRecoveryFailure");
  expect(unrelatedRead.calls.map(c => c.method)).toEqual(["GET"]);
});

test("an exact existing recovery Plan can be reviewed by GET after an uncertain submission", async () => {
  const acceptedPlan = { ...destroyPlan, providerResolutions: [{
    requirement: { providerSource: "registry.opentofu.org/cloudflare/cloudflare", alias: "default" },
    status: "resolved_provider_connection", connectionId: "conn_shared",
  }] };
  const issued = await invoke(recoverArgs, () => {
    throw Error("synthetic acknowledgement lost after Plan was accepted");
  });
  expect(issued.result.status).toBe("unconfirmed");
  expect(issued.calls.map(c => c.method)).toEqual(["POST"]);

  const resumed = await invoke(reviewDestroyArgs, () => Response.json({ run: acceptedPlan }));
  expect(resumed.code).toBe(0);
  expect(resumed.result).toMatchObject({ status: "review_required", appId: "cap_owned", planRunId: acceptedPlan.id,
    plan: { providerConnections: [{ alias: "default", connectionId: "conn_shared" }] } });
  expect(resumed.calls.map(c => [c.method, new URL(c.url).pathname]))
    .toEqual([["GET", `/api/v1/runs/${acceptedPlan.id}`]]);
});

test("existing recovery review reports pending and failed Runs without guessing a new Plan", async () => {
  for (const [status, resultStatus, exitCode] of [["queued", "plan_pending", 0], ["failed", "failed", 1]] as const) {
    const run = { ...destroyPlan, status, planDigest: undefined, errorCode: status === "failed" ? "provider_refused" : undefined };
    const result = await invoke(reviewDestroyArgs, () => Response.json({ run }));
    expect(result.code).toBe(exitCode);
    expect(result.result).toMatchObject({ status: resultStatus, planRunId: run.id, planStatus: status });
    expect(result.result.plan).toBeUndefined();
    expect(result.calls.map(c => c.method)).toEqual(["GET"]);
  }

  for (const run of [
    { ...destroyPlan, id: "another_plan" },
    { ...destroyPlan, capsuleId: "cap_other" },
    { ...destroyPlan, type: "plan" },
    { ...destroyPlan, planDigest: undefined },
  ]) {
    const result = await invoke(reviewDestroyArgs, () => Response.json({ run }));
    expect(result.code).toBe(1);
    expect(result.result).toMatchObject({ status: "refused", planRunId: destroyPlan.id });
    expect(result.result.plan).toBeUndefined();
    expect(result.calls.map(c => c.method)).toEqual(["GET"]);
  }
});

test("uninstall review shows the effective Connections, including a carried-forward replacement", async () => {
  const providerSource = "registry.opentofu.org/cloudflare/cloudflare";
  const resolutions = [
    { requirement: { providerSource, alias: "primary" }, status: "resolved_provider_connection", connectionId: "conn_shared",
      evidence: { kind: "provider_connection", privateKey: "fixture-must-not-print" } },
    { requirement: { providerSource, alias: "inherited" }, status: "resolved_provider_connection",
      evidence: { kind: "provider_connection", connectionId: "conn_prior", requiredEnvNames: ["FIXTURE_MUST_NOT_PRINT"] } },
  ];
  const args = recoverArgs.map(value => value === JSON.stringify(destroyPairs) ? JSON.stringify([destroyPairs[0]]) : value);
  const r = await invoke(args, async req => {
    expect(await req.json()).toEqual({ destroyProviderConnectionReplacements: [destroyPairs[0]] });
    return Response.json({ run: { ...destroyPlan, providerResolutions: resolutions } }, { status: 201 });
  });
  expect(r.code).toBe(0);
  expect(r.result.plan.providerConnections).toEqual([
    { provider: providerSource, alias: "primary", status: "resolved_provider_connection", connectionId: "conn_shared" },
    { provider: providerSource, alias: "inherited", status: "resolved_provider_connection", connectionId: "conn_prior" },
  ]);
  expect(JSON.stringify(r.result)).not.toMatch(/must-not-print|MUST_NOT_PRINT/u);
});

test("apps apply approves and executes only the saved Destroy Plan after review", async () => {
  let approved = false;
  const r = await invoke(destroyApplyArgs, req => {
    const path = new URL(req.url).pathname;
    if (path === `/api/v1/runs/${destroyPlan.id}/approve`) {
      approved = true;
      return Response.json({ run: { ...destroyPlan, status: "succeeded" } });
    }
    return normalDestroy(req, { plan: approved ? { ...destroyPlan, status: "succeeded" } : destroyPlan });
  });
  expect(r.code).toBe(0);
  expect(r.result).toMatchObject({ status: "succeeded", appId: "cap_owned",
    planRunId: destroyPlan.id, runId: destroyApply.id, runStatus: "succeeded" });
  expect(r.err.some(s => {
    const value = JSON.parse(s);
    if (value.status !== "applying_reviewed_plan") return false;
    expect(s).not.toContain("synthetic-account-pat");
    return true;
  })).toBe(true);
  expect(r.calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual([
    `/api/v1/runs/${destroyPlan.id}/approve`, `/api/v1/runs/${destroyPlan.id}/apply`,
  ]);
  expect(r.calls.filter(c => c.method === "GET" && new URL(c.url).pathname === "/api/v1/capsules/cap_owned/runs")
    .every(c => new URL(c.url).searchParams.getAll("type").join(",") === "destroy_apply")).toBe(true);
});

test("Destroy apply observe-only reads a linked failed Run and sends no mutation", async () => {
  const failed = { ...destroyApply, status: "failed", errorCode: "runner_execution_indeterminate" };
  const args = destroyApplyArgs.filter(s => s !== "--yes").concat("--observe-only");
  const r = await invoke(args, req => normalDestroy(req, { history: { runs: [failed] }, apply: failed }));
  expect(r.code).toBe(1);
  expect(r.result).toMatchObject({ status: "failed", planRunId: destroyPlan.id,
    runId: failed.id, runStatus: "failed", code: failed.errorCode });
  expect(r.calls.every(c => c.method === "GET")).toBe(true);
});

test("apps apply identifies a confirmed Destroy connection refusal without resubmitting", async () => {
  for (const reason of ["provider_connection_setup_required", "provider_connection_not_ready"]) {
    const applyPath = `/api/v1/runs/${destroyPlan.id}/apply`;
    const result = await invoke(destroyApplyArgs, req => {
      if (new URL(req.url).pathname === applyPath && req.method === "POST") {
        return Response.json({ error: {
          code: "failed_precondition", message: "private-connection-diagnostic", details: { reason },
        } }, { status: 409 });
      }
      return normalDestroy(req, { plan: { ...destroyPlan, status: "succeeded" } });
    });
    expect(result.code).toBe(1);
    expect(result.result).toMatchObject({ status: "refused", planRunId: destroyPlan.id,
      lastObservedPlanStatus: "succeeded", code: "failed_precondition", reason });
    expect(result.result.recovery).toContain("apps recover-uninstall");
    expect(result.result.recovery).toContain("--connections");
    expect(JSON.stringify(result.result)).not.toContain("private-connection-diagnostic");
    expect(result.calls.map(req => `${req.method} ${new URL(req.url).pathname}`)).toEqual([
      `GET /api/v1/runs/${destroyPlan.id}`, "GET /api/v1/capsules/cap_owned/runs",
      "GET /api/v1/capsules/cap_owned", `POST ${applyPath}`,
      `GET /api/v1/runs/${destroyPlan.id}`, "GET /api/v1/capsules/cap_owned/runs",
    ]);
  }
});

test("apps apply preserves unknown or observed Destroy outcomes after a connection refusal", async () => {
  for (const mode of ["unrelated", "approval", "readback-denied", "changed-plan", "linked-apply"]) {
    const replacementRefusal = mode === "changed-plan" || mode === "linked-apply";
    const receipt = Response.json({ error: {
      code: "failed_precondition", details: {
        reason: replacementRefusal ? "destroy_connection_recovery_unproven"
          : mode === "unrelated" ? "some_other_conflict" : "provider_connection_setup_required",
        ...(replacementRefusal ? { connectionRecoveryFailure: "bindings_mismatch" } : {}),
      },
    } }, { status: 409 });
    let sent = false;
    const result = await invoke(destroyApplyArgs, req => {
      const path = new URL(req.url).pathname;
      const receiptPath = `/api/v1/runs/${destroyPlan.id}/${mode === "approval" ? "approve" : "apply"}`;
      if (path === receiptPath && req.method === "POST") {
        sent = true;
        return receipt;
      }
      if (sent && mode === "readback-denied") return Response.json({ error: "forbidden" }, { status: 403 });
      return normalDestroy(req, {
        plan: { ...destroyPlan, status: mode === "approval" ? "waiting_approval" : "succeeded",
          planDigest: sent && mode === "changed-plan" ? `sha256:${"b".repeat(64)}` : destroyPlan.planDigest },
        history: { runs: sent && mode === "linked-apply" ? [destroyApply] : [] },
      });
    });
    expect(result.calls.filter(req => req.method === "POST")).toHaveLength(1);
    expect(result.result.reason).toBeUndefined();
    expect(result.result.connectionRecoveryFailure).toBeUndefined();
    if (mode === "linked-apply") {
      expect(result.code).toBe(0);
      expect(result.result).toMatchObject({ status: "succeeded", runId: destroyApply.id });
    } else {
      expect(result.code).toBe(1);
      expect(result.result).toMatchObject({ status: "indeterminate", planRunId: destroyPlan.id });
      expect(result.result.recovery).toContain("--observe-only");
    }
  }
});

test("apps apply explains a refused Destroy when the replacement no longer matches the reviewed app", async () => {
  const reason = "destroy_connection_recovery_unproven";
  const applyPath = `/api/v1/runs/${destroyPlan.id}/apply`;
  for (const failure of ["bindings_mismatch", "replacement_unverified", "replacement_auth_mode_mismatch",
    "applied_evidence_unavailable", "private-diagnostic", undefined] as const) {
    const result = await invoke(destroyApplyArgs, request => {
      if (new URL(request.url).pathname === applyPath && request.method === "POST") {
        return Response.json({ error: {
          code: "failed_precondition",
          message: "prevent-secret-diagnostic-leak",
          details: { reason, connectionRecoveryFailure: failure },
        } }, { status: 409 });
      }
      return normalDestroy(request, { plan: { ...destroyPlan, status: "succeeded" } });
    });
    expect(result.code).toBe(1);
    expect(result.calls.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /api/v1/runs/${destroyPlan.id}`, "GET /api/v1/capsules/cap_owned/runs",
      "GET /api/v1/capsules/cap_owned", `POST ${applyPath}`,
      `GET /api/v1/runs/${destroyPlan.id}`, "GET /api/v1/capsules/cap_owned/runs",
    ]);
    const diagnostic = JSON.stringify(result.result);
    expect(diagnostic).not.toContain("prevent-secret-diagnostic-leak");
    expect(diagnostic).not.toContain("private-diagnostic");
    if (failure === undefined || failure === "private-diagnostic") {
      expect(result.result.status).toBe("indeterminate");
      expect(result.result.connectionRecoveryFailure).toBeUndefined();
      expect(result.result.recovery).toContain("--observe-only");
    } else {
      expect(result.result).toMatchObject({ status: "refused", lastObservedPlanStatus: "succeeded",
        code: "failed_precondition", reason, connectionRecoveryFailure: failure });
      if (failure === "applied_evidence_unavailable") {
        expect(result.result.recovery).toContain("applied state");
        expect(result.result.recovery).not.toContain("--connections");
      } else {
        expect(result.result.recovery).toContain("same cloud account");
        expect(result.result.recovery).toContain("apps recover-uninstall with --connections");
      }
    }
  }
});

test("revision and Destroy Plan selectors are reciprocal and stale Destroy state cannot write", async () => {
  const wrongRevision = await invoke(
    destroyApplyArgs, req => normalDestroy(req, { plan: { ...plan, id: destroyPlan.id } }));
  expect(wrongRevision.code).toBe(1);
  expect(wrongRevision.calls.filter(c => c.method === "POST")).toHaveLength(0);
  const wrongDestroy = await invoke(
    applyArgs, req => normal(req, { plan: { ...destroyPlan, id: plan.id } }));
  expect(wrongDestroy.code).toBe(1);
  expect(wrongDestroy.calls.filter(c => c.method === "POST")).toHaveLength(0);
  const stale = await invoke(
    destroyApplyArgs, req => normalDestroy(req, { capsule: { ...capsule, currentStateGeneration: 2 } }));
  expect(stale.code).toBe(1);
  expect(stale.calls.filter(c => c.method === "POST")).toHaveLength(0);
});

test("a typed revision state conflict still requires matching Plan evidence and no linked Apply", async () => {
  const applyPath = `/api/v1/runs/${plan.id}/apply`;
  for (const mode of ["same-plan", "changed-plan", "linked-apply"] as const) {
    let submitted = false;
    const result = await invoke(applyArgs, req => {
      if (req.method === "POST" && new URL(req.url).pathname === applyPath) {
        submitted = true;
        return Response.json({ error: { code: "failed_precondition", message: "private-state-diagnostic",
          details: { reason: "state_generation_mismatch" } } }, { status: 409 });
      }
      return normal(req, {
        plan: submitted && mode === "changed-plan" ? { ...plan, sourceSnapshotId: "snapshot_changed" } : plan,
        history: { runs: submitted && mode === "linked-apply" ? [apply] : [] },
      });
    });
    expect(result.calls.filter(req => req.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(result.result)).not.toContain("private-state-diagnostic");
    if (mode === "same-plan") {
      expect(result.code).toBe(1);
      expect(result.result).toMatchObject({ status: "refused", reason: "state_generation_mismatch", planRunId: plan.id });
    } else if (mode === "changed-plan") {
      expect(result.code).toBe(1);
      expect(result.result).toMatchObject({ status: "indeterminate", planRunId: plan.id });
      expect(result.result.reason).toBeUndefined();
    } else {
      expect(result.code).toBe(0);
      expect(result.result).toMatchObject({ status: "succeeded", runId: apply.id });
    }
  }
});

test("apps apply executes only the exact saved revision Plan after emitting value-free review", async () => {
  let sawReview = false; const out: string[] = []; const before = globalThis.fetch; const calls: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init); calls.push(req);
    if (req.method === "POST") expect(sawReview).toBe(true);
    return normal(req, { plan: { ...plan, planArtifactRef: "private://must-not-print", variables: { password: "synthetic-must-not-print" } } });
  }) as typeof fetch;
  try {
    expect(await main(applyArgs, { stdout: s => out.push(s), stderr: s => {
      const value = JSON.parse(s); expect(value.status).toBe("applying_reviewed_plan");
      expect(s).not.toContain("private://"); expect(s).not.toContain("synthetic-must-not-print"); sawReview = true;
    } })).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ status: "succeeded", runId: apply.id, runStatus: "succeeded" });
    expect(calls.filter(c => c.method === "GET" && new URL(c.url).pathname === `/api/v1/runs/${apply.id}`)).toHaveLength(0);
    expect(calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual([`/api/v1/runs/${plan.id}/apply`]);
  } finally { globalThis.fetch = before; }
});

test("new commands reject absent, ambiguous and unknown mutation flags before HTTP", async () => {
  for (const args of [
    ["apps", "update", "cap_owned", "--ref", ref],
    ["apps", "update", "cap_owned", "--ref", "--idempotency-key", "key"],
    ["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "key", "--apply"],
    ["apps", "update", "cap_owned", "--ref", ref, "--ref", "different", "--idempotency-key", "key"],
    ["apps", "rollback", "cap_owned", "--state-version", rollbackTarget.id],
    [...rollbackArgs, "--yes"],
    [...rollbackArgs, "--rollback-plan", rollbackPlan.id],
    ["apps", "rollback", "cap_owned", "--rollback-plan", rollbackPlan.id],
    ["apps", "rollback", "cap_owned", "--state-version", rollbackTarget.id, "--rollback-plan", ".."],
    ["apps", "apply", "cap_owned", "--plan", plan.id],
    ["apps", "apply", "cap_owned", "--plan", plan.id, "--yes=true"],
    ["apps", "apply", "cap_owned", "--plan", plan.id, "--yes", "extra"],
    [...applyArgs, "--destroy-plan", destroyPlan.id],
    [...applyArgs, "--timeout-ms", "0"],
  ]) {
    const result = await invoke(args, () => { throw Error("HTTP must not be reached"); });
    expect(result.code).toBe(2); expect(result.calls).toHaveLength(0);
  }
});

test("rollback reads the StateVersion and exact saved Plan without approval or Apply", async () => {
  const r = await invoke(rollbackArgs, async req => {
    const path = new URL(req.url).pathname;
    if (path === `/api/v1/state-versions/${rollbackTarget.id}`) return Response.json({ stateVersion: rollbackTarget });
    if (path.endsWith("/rollback-plan")) {
      expect(req.method).toBe("POST");
      expect(req.headers.get("idempotency-key")).toBe("rollback=stable");
      expect(await req.json()).toEqual({});
      return Response.json({ run: { ...rollbackPlan, status: "queued", planDigest: undefined } }, { status: 201 });
    }
    expect(path).toBe(`/api/v1/runs/${rollbackPlan.id}`);
    return Response.json({ run: { ...rollbackPlan, rawState: "raw-canary" } });
  });
  expect(r.code).toBe(0);
  expect(r.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
    "GET /api/v1/state-versions/state_target", "POST /api/v1/state-versions/state_target/rollback-plan", "GET /api/v1/runs/plan_rollback",
  ]);
  expect(r.calls.map(c => c.redirect)).toEqual(["follow", "error", "follow"]);
  expect(r.result).toMatchObject({ status: "review_required", appId: "cap_owned", stateVersionId: rollbackTarget.id,
    planRunId: rollbackPlan.id, plan: { stateVersionId: rollbackTarget.id }, reviewUrl: `${origin}/runs/${rollbackPlan.id}` });
  expect(JSON.stringify(r.result)).not.toContain("raw-canary");
});

test("rollback refuses another app's StateVersion and a mismatched saved rollback target", async () => {
  const wrongApp = await invoke(rollbackArgs, () => Response.json({ stateVersion: { ...rollbackTarget, capsuleId: "cap_other" } }));
  expect(wrongApp.code).toBe(1);
  expect(wrongApp.result.code).toBe("state_version_identity_mismatch");
  expect(wrongApp.calls.map(r => r.method)).toEqual(["GET"]);

  const wrongTarget = await invoke(rollbackArgs, req => {
    const path = new URL(req.url).pathname;
    if (path === "/api/v1/state-versions/state_target") return Response.json({ stateVersion: rollbackTarget });
    if (req.method === "POST") return Response.json({ run: rollbackPlan }, { status: 201 });
    return Response.json({ run: { ...rollbackPlan, origin: { kind: "rollback", stateVersionId: "state_other" } } });
  });
  expect(wrongTarget.code).toBe(1);
  expect(wrongTarget.result).toMatchObject({ status: "unconfirmed", code: "rollback_plan_mismatch", planRunId: rollbackPlan.id });
  expect(wrongTarget.calls.filter(req => req.method === "POST").map(req => new URL(req.url).pathname)).toEqual([
    "/api/v1/state-versions/state_target/rollback-plan",
  ]);
});

test("rollback points to a read-only recovery after the Plan is acknowledged", async () => {
  const r = await invoke(rollbackArgs, req => {
    if (new URL(req.url).pathname === `/api/v1/state-versions/${rollbackTarget.id}`) {
      return Response.json({ stateVersion: rollbackTarget });
    }
    if (req.method === "POST") return Response.json({ run: rollbackPlan }, { status: 201 });
    throw new TypeError("fixture lost a Run read after the acknowledgement");
  });
  expect(r.code).toBe(1);
  expect(r.calls.map(req => req.method)).toEqual(["GET", "POST", "GET"]);
  expect(r.result).toMatchObject({ status: "unconfirmed", planRunId: rollbackPlan.id });
  expect(r.result.recovery).toContain("--rollback-plan");
});

test("saved rollback review rejects a different Run, app, workspace or target without POST", async () => {
  const args = rollbackArgs.flatMap(arg => arg.startsWith("--idempotency-key") ? ["--rollback-plan", rollbackPlan.id] : [arg]);
  for (const run of [
    { ...rollbackPlan, id: "plan_other" },
    { ...rollbackPlan, capsuleId: "cap_other" },
    { ...rollbackPlan, workspaceId: "ws_other" },
    { ...rollbackPlan, origin: { kind: "rollback", stateVersionId: "state_other" } },
    { ...rollbackPlan, origin: { kind: "revision", ref } },
  ]) {
    const r = await invoke(args, req => new URL(req.url).pathname === `/api/v1/state-versions/${rollbackTarget.id}`
      ? Response.json({ stateVersion: rollbackTarget })
      : Response.json({ run }));
    expect(r.code).toBe(1);
    expect(r.calls.map(req => req.method)).toEqual(["GET", "GET"]);
    expect(r.result).toMatchObject({ status: "refused", stateVersionId: rollbackTarget.id });
    expect(r.result).not.toHaveProperty("plan");
  }
});

test("saved rollback Apply keeps the state cursor and destructive guards", async () => {
  const args = applyArgs.map(arg => arg === plan.id ? rollbackPlan.id : arg);
  for (const [saved, current, code] of [
    [rollbackPlan, { ...capsule, currentStateGeneration: 3, currentStateVersionId: "state_drift" }, "plan_state_changed"],
    [{ ...rollbackPlan, summary: { add: 0, change: 0, destroy: 1 } },
      { ...capsule, currentStateGeneration: 2, currentStateVersionId: "state_head" }, "destructive_confirmation_required"],
  ] as const) {
    const r = await invoke(args, req => {
      expect(req.method).toBe("GET");
      const path = new URL(req.url).pathname;
      if (path === `/api/v1/runs/${rollbackPlan.id}`) return Response.json({ run: saved });
      if (path.endsWith("/runs")) return Response.json({ runs: [] });
      return Response.json({ capsule: current });
    });
    expect(r.code).toBe(1);
    expect(r.result.code).toBe(code);
  }
});

test("Accounts operations never fall back to the configured operator token", async () => {
  const oldAccount = process.env.TAKOSUMI_ACCOUNT_TOKEN; const oldOperator = process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  delete process.env.TAKOSUMI_ACCOUNT_TOKEN; process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN = "synthetic-operator-not-user";
  try {
    const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "key", "--url", origin, "--json"], () => { throw Error("no HTTP"); });
    expect(r.code).toBe(1); expect(r.calls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("synthetic-operator-not-user");
  } finally {
    if (oldAccount === undefined) delete process.env.TAKOSUMI_ACCOUNT_TOKEN; else process.env.TAKOSUMI_ACCOUNT_TOKEN = oldAccount;
    if (oldOperator === undefined) delete process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN; else process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN = oldOperator;
  }
});

test("revision ref inline equals is exact, untrusted response links are ignored and coordinator progress is bounded", async () => {
  const requested = "release=v2"; let count = 0;
  const r = await invoke(["apps", "update", "cap_owned", `--ref=${requested}`, "--idempotency-key=stable=key", "--url", origin, "--token", "pat", "--json"], async req => {
    const path = new URL(req.url).pathname;
    if (path === `/api/v1/runs/${plan.id}`) return Response.json({ run: { ...plan, origin: { kind: "revision", ref: requested } } });
    if (path.endsWith("/revision-plans")) expect(await req.json()).toEqual({ ref: requested });
    else expect(path).toBe("/api/v1/revision-plans/revision_one/reconcile");
    count++;
    return Response.json({ revisionPlan: { ...revision, revision: { ...revision.revision, targetRef: requested } },
      nextAction: count === 1 ? "reconcile" : "review_run", links: { run: "https://foreign.invalid/steal", reconcile: "https://foreign.invalid/steal" } });
  });
  expect(r.code).toBe(0); expect(r.calls[0]!.headers.get("idempotency-key")).toBe("stable=key");
  expect(r.result.reviewUrl).toBe(`${origin}/runs/${plan.id}`);
  expect(r.calls.every(c => new URL(c.url).origin === origin)).toBe(true);
});

test("update rejects a changed app, ref, coordinator or Plan identity without approving or applying", async () => {
  for (const change of [{ capsuleId: "cap_other" }, { revision: { ...revision.revision, targetRef: "other" } }]) {
    const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "key", "--token", "pat", "--url", origin, "--json"], () =>
      Response.json({ revisionPlan: { ...revision, ...change }, nextAction: "review_run", links: {} }));
    expect(r.code).toBe(1); expect(r.calls).toHaveLength(1); expect(r.result.code).toBe("revision_identity_mismatch");
  }
});

test("a linked failed Apply on an older page consumes the Plan; current generation drift does not trigger replay", async () => {
  const failed = { ...apply, status: "failed", errorCode: "runner_execution_indeterminate" };
  const r = await invoke(applyArgs, req => {
    if (new URL(req.url).pathname.endsWith("/runs") && req.method === "GET") {
      return Response.json(new URL(req.url).searchParams.has("cursor") ? { runs: [failed] } : { runs: [], nextCursor: "older" });
    }
    return normal(req, { capsule: { ...capsule, currentStateGeneration: 2 }, apply: failed });
  });
  expect(r.code).toBe(1); expect(r.result).toMatchObject({ status: "failed", runId: failed.id, runStatus: "failed" });
  expect(r.calls.filter(c => c.method !== "GET")).toHaveLength(0);
});

test("linked Apply resumption requires current individual Run evidence", async () => {
  for (const mode of ["normal", "observe", "approved-race"] as const) {
    for (const evidence of ["failed", "denied", "mismatch"] as const) {
      let approved = false; let historyReads = 0;
      const otherApply = { ...apply, id: "apply_later_locator" };
      const args = mode === "observe" ? applyArgs.filter(a => a !== "--yes").concat("--observe-only") : applyArgs;
      const r = await invoke(args, req => {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/approve") && req.method === "POST") {
          approved = true;
          return Response.json({ run: plan });
        }
        if (path.endsWith("/runs")) {
          historyReads += 1;
          return Response.json({ runs: mode === "approved-race" && !approved ? [] : mode === "approved-race" && evidence === "denied" && historyReads > 2 ? [otherApply] : [apply] });
        }
        if (path === `/api/v1/runs/${otherApply.id}`) return Response.json({ run: otherApply });
        if (path === `/api/v1/runs/${apply.id}`) {
          if (evidence === "denied") return Response.json({ error: { code: "forbidden" } }, { status: 403 });
          return Response.json({ run: { ...apply, ...(evidence === "failed" ? { status: "failed", errorCode: "runner_execution_indeterminate" } : { planRunId: "other_plan" }) } });
        }
        return normal(req, { plan: mode === "approved-race" && !approved ? { ...plan, status: "waiting_approval" } : plan });
      });
      expect(r.code).toBe(1);
      expect(r.result.runId).toBe(apply.id);
      if (evidence === "failed") {
        expect(r.result).toMatchObject({ status: "failed", runStatus: "failed", code: "runner_execution_indeterminate" });
      } else {
        expect(r.result.status).toBe(mode === "normal" ? "refused" : "indeterminate");
        expect(r.result.runStatus).toBeUndefined();
        expect(r.result.code).toBe(evidence === "denied" ? "forbidden" : "apply_identity_mismatch");
      }
      const mutations = r.calls.filter(c => c.method !== "GET").map(c => new URL(c.url).pathname);
      expect(mutations).toEqual(mode === "approved-race" ? [`/api/v1/runs/${plan.id}/approve`] : []);
      expect(r.calls.filter(c => c.method === "GET" && new URL(c.url).pathname === `/api/v1/runs/${apply.id}`)).toHaveLength(1);
      expect(historyReads).toBe(mode === "approved-race" ? 2 : 1);
      expect(r.calls.some(c => new URL(c.url).pathname === `/api/v1/runs/${otherApply.id}`)).toBe(false);
    }
  }
});

test("cycle or malformed Run history never proves absence of Apply", async () => {
  for (const history of [{ runs: [], nextCursor: "same" }, { unrelated: [] }]) {
    const r = await invoke(applyArgs, req => normal(req, { history }));
    expect(r.code).toBe(1); expect(r.result.code).toBe("run_history_incomplete");
    expect(r.calls.every(c => c.method === "GET")).toBe(true);
  }
});

test("wrong app, stale generation, policy failure and unknown/deleted changes refuse before mutation", async () => {
  for (const overrides of [
    { plan: { ...plan, capsuleId: "cap_other" } },
    { capsule: { ...capsule, currentStateGeneration: 2 } },
    { plan: { ...plan, policyStatus: "deny" } },
    { plan: { ...plan, summary: undefined } },
    { plan: { ...plan, summary: { add: 0, change: 0, destroy: 1 } } },
  ]) {
    const r = await invoke(applyArgs, req => normal(req, overrides));
    expect(r.code).toBe(1); expect(r.calls.every(c => c.method === "GET")).toBe(true);
  }
});

test("lost Apply ACK is reconciled by exact linked Run reads with only one Apply POST", async () => {
  let posted = false;
  const r = await invoke(applyArgs, req => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/apply") && req.method === "POST") { posted = true; throw Error("synthetic lost ACK with private-must-not-print"); }
    if (path.endsWith("/runs")) return Response.json({ runs: posted ? [apply] : [] });
    if (path === `/api/v1/runs/${apply.id}`) return Response.json({ run: apply });
    return normal(req);
  });
  expect(r.code).toBe(0); expect(r.result).toMatchObject({ status: "succeeded", runId: apply.id });
  expect(r.calls.filter(c => c.method === "POST")).toHaveLength(1);
  const histories = r.calls
    .map(call => new URL(call.url))
    .filter(url => url.pathname === "/api/v1/capsules/cap_owned/runs");
  expect(histories.map(url => url.searchParams.getAll("planRunId"))).toEqual([[plan.id], [plan.id]]);
  expect(JSON.stringify(r.result)).not.toContain("private-must-not-print");
});

for (const status of ["succeeded", "failed", "cancelled", "expired"]) {
  test(`terminal Apply readback after lost ACK preserves the ${status} Run result`, async () => {
    let posted = false;
    const terminal = { ...apply, status, ...(status !== "succeeded" ? { errorCode: "fixture_terminal_code" } : {}) };
    const r = await invoke(applyArgs, req => {
      const path = new URL(req.url).pathname;
      if (req.method === "POST") { posted = true; throw Error("synthetic lost ACK"); }
      if (path.endsWith("/runs")) return Response.json({ runs: posted ? [terminal] : [] });
      if (path === `/api/v1/runs/${apply.id}`) return Response.json({ run: terminal });
      return normal(req);
    });
    expect(r.code).toBe(status === "succeeded" ? 0 : 1);
    expect(r.result).toEqual({
      status: status === "succeeded" ? "succeeded" : "failed", appId: "cap_owned", planRunId: plan.id,
      runId: apply.id, runStatus: status, runUrl: `${origin}/runs/${apply.id}`,
      ...(status !== "succeeded" ? { code: "fixture_terminal_code",
        note: "A failed or stopped Apply may have effects. Do not repeat it as a new Plan." } : {}),
    });
    expect(r.calls.filter(c => c.method === "POST")).toHaveLength(1);
    expect(r.calls.at(-1)!.url).toBe(`${origin}/api/v1/runs/${apply.id}`);
  });
}

test("terminal Apply readback rejects changed evidence and current authorization refusal", async () => {
  for (const change of ["plan", "run", "authorization"] as const) {
    let posted = false;
    const r = await invoke(applyArgs, req => {
      const path = new URL(req.url).pathname;
      if (req.method === "POST") { posted = true; throw Error("synthetic lost ACK"); }
      if (posted && path === `/api/v1/runs/${plan.id}`) {
        if (change === "authorization") return Response.json({ error: { code: "forbidden" } }, { status: 403 });
        return Response.json({ run: change === "plan" ? { ...plan, planDigest: "different" } : plan });
      }
      if (path.endsWith("/runs")) return Response.json({ runs: posted ? [apply] : [] });
      if (path === `/api/v1/runs/${apply.id}`) return Response.json({ run: { ...apply, planRunId: "other_plan" } });
      return normal(req);
    });
    expect(r.code).toBe(1);
    expect(r.result.status).toBe("indeterminate");
    expect(r.result.runStatus).toBeUndefined();
    expect(r.calls.filter(c => c.method === "POST")).toHaveLength(1);
  }
});

test("observing a failed Apply projection points to a separate manual removal review", async () => {
  const terminal = { ...apply, status: "failed", errorCode: "apply_output_projection_failed" };
  const args = applyArgs.filter(arg => arg !== "--yes").concat("--observe-only");
  const result = await invoke(args, req => normal(req, { apply: terminal, history: { runs: [terminal] } }));
  expect(result.code).toBe(1);
  expect(result.result).toMatchObject({
    status: "failed", runId: apply.id, code: "apply_output_projection_failed",
    note: expect.stringContaining("apps recover-uninstall <app-id> --prepare"),
  });
  expect(result.calls.every(call => call.method === "GET")).toBe(true);
});

for (const [kind, savedPlan, resultRun, args, serve] of [
  ["revision", plan, apply, applyArgs, normal],
  ["uninstall", destroyPlan, destroyApply, destroyApplyArgs, normalDestroy],
] as const) {
  test(`a persisted unknown ${kind} result stays indeterminate on Apply and exact readback`, async () => {
    const approvedPlan = { ...savedPlan, status: "succeeded" };
    const terminal = { ...resultRun, status: "failed", errorCode: "runner_mutation_indeterminate" };
    for (const mode of ["execute", "observe", "lost-ack"] as const) {
      let posted = false;
      const r = await invoke(mode === "observe" ? args.filter((arg) => arg !== "--yes").concat("--observe-only") : args, (req) => {
        const url = new URL(req.url);
        if (url.pathname === `/api/v1/runs/${savedPlan.id}/apply` && req.method === "POST") {
          posted = true;
          if (mode === "lost-ack") throw new Error("synthetic lost acknowledgement");
        }
        if (url.pathname.endsWith("/runs")) expect(url.searchParams.getAll("planRunId")).toEqual([savedPlan.id]);
        return serve(req, { plan: approvedPlan, apply: terminal,
          history: { runs: mode === "observe" || posted ? [terminal] : [] } });
      });
      expect(r.code).toBe(1);
      expect(r.result).toMatchObject({
        status: "indeterminate", appId: "cap_owned", planRunId: savedPlan.id,
        runId: resultRun.id, runStatus: "failed", code: "runner_mutation_indeterminate",
        runUrl: `${origin}/runs/${resultRun.id}`,
      });
      expect(r.calls.filter((call) => call.method !== "GET").map((call) => new URL(call.url).pathname))
        .toEqual(mode === "observe" ? [] : [`/api/v1/runs/${savedPlan.id}/apply`]);
      if (mode !== "execute") {
        expect(r.calls.at(-1)?.url).toBe(`${origin}/api/v1/runs/${resultRun.id}`);
      }
    }
  });
}

test("late Apply response cannot replace refused fresh readback with success", async () => {
  let posted = false; let finish: (() => void) | undefined;
  const r = await invoke([...applyArgs, "--timeout-ms", "15"], async req => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") {
      posted = true;
      return new Response(new ReadableStream({ start(controller) { finish = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ run: apply }))); controller.close();
      }; } }));
    }
    if (posted && path === `/api/v1/runs/${plan.id}`) {
      finish?.();
      await new Promise(resolve => setTimeout(resolve, 0));
      return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    }
    return normal(req);
  });
  expect(r.code).toBe(1);
  expect(r.result.status).toBe("indeterminate");
  expect(r.result.runStatus).toBeUndefined();
  expect(r.calls.filter(c => c.method === "POST")).toHaveLength(1);
});

for (const late of [false, true]) {
  test(`changed approval Plan cannot replace pinned recovery intent (${late ? "late" : "immediate"})`, async () => {
    let approved = false; let planReads = 0; let finish: (() => void) | undefined;
    const changed = { ...plan, planDigest: `sha256:${"b".repeat(64)}` };
    const r = await invoke([...applyArgs, "--timeout-ms", "15"], async req => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/approve")) { approved = true; return Response.json({ run: plan }); }
      if (path === `/api/v1/runs/${plan.id}`) {
        planReads++;
        if (!approved) return Response.json({ run: { ...plan, status: "waiting_approval" } });
        if (late && planReads === 2) return new Response(new ReadableStream({ start(controller) { finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ run: changed }))); controller.close();
        }; } }));
        if (late) { finish?.(); await new Promise(resolve => setTimeout(resolve, 0)); }
        return Response.json({ run: changed });
      }
      if (path.endsWith("/runs")) return Response.json({ runs: approved ? [apply] : [] });
      if (path === `/api/v1/runs/${apply.id}`) return Response.json({ run: apply });
      return normal(req);
    });
    expect(r.code).toBe(1);
    expect(r.result.status).toBe("indeterminate");
    expect(r.result.runStatus).toBeUndefined();
    expect(r.calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual([`/api/v1/runs/${plan.id}/approve`]);
    expect(planReads).toBe(3);
  });
}

test("missing ACK without linked Run stays indeterminate; observe-only never writes", async () => {
  const lost = await invoke(applyArgs, req => { if (req.method === "POST") throw Error("lost"); return normal(req); });
  expect(lost.code).toBe(1); expect(lost.result.status).toBe("indeterminate");
  expect(lost.calls.filter(c => c.method === "POST")).toHaveLength(1);
  const observed = await invoke(applyArgs.filter(s => s !== "--yes").concat("--observe-only"), req => normal(req));
  expect(observed.code).toBe(1); expect(observed.result.status).toBe("indeterminate");
  expect(observed.calls.every(c => c.method === "GET")).toBe(true);
});

test("201 queued is not completion; deadline preserves the known Apply id and only reads afterward", async () => {
  let posted = false; const queued = { ...apply, status: "queued" };
  const r = await invoke([...applyArgs, "--timeout-ms", "15"], req => {
    if (req.method === "POST") posted = true;
    if (new URL(req.url).pathname.endsWith("/runs")) return Response.json({ runs: posted ? [queued] : [] });
    if (new URL(req.url).pathname === `/api/v1/runs/${apply.id}`) return Response.json({ run: queued });
    return normal(req, { apply: queued });
  });
  expect(r.code).toBe(1); expect(r.result).toMatchObject({ status: "pending", runId: apply.id, runStatus: "queued" });
  expect(r.calls.filter(c => c.method === "POST")).toHaveLength(1);
});

for (const [kind, savedPlan, accepted, args, serve] of [
  ["revision", plan, apply, applyArgs, normal],
  ["uninstall", destroyPlan, destroyApply, destroyApplyArgs, normalDestroy],
] as const) {
  test(`an accepted ${kind} Apply is read by ID even if the history list omits it`, async () => {
    const r = await invoke([...args, "--timeout-ms", "100"], (req) => {
      const path = new URL(req.url).pathname;
      if (path === `/api/v1/runs/${accepted.id}`) return Response.json({ run: accepted });
      return serve(req, {
        plan: { ...savedPlan, status: "succeeded" }, apply: { ...accepted, status: "queued" },
      });
    });
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ status: "succeeded", runId: accepted.id });
    expect(r.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /api/v1/runs/${savedPlan.id}`,
      "GET /api/v1/capsules/cap_owned/runs",
      "GET /api/v1/capsules/cap_owned",
      `POST /api/v1/runs/${savedPlan.id}/apply`,
      `GET /api/v1/runs/${accepted.id}`,
    ]);
    expect(r.calls[3]!.redirect).toBe("error");
  });
}

test("a refused individual read preserves the accepted Apply ID and its last known status", async () => {
  const r = await invoke([...applyArgs, "--timeout-ms", "100"], (req) => {
    if (new URL(req.url).pathname === `/api/v1/runs/${apply.id}`) {
      return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    }
    return normal(req, { apply: { ...apply, status: "queued" } });
  });
  expect(r.code).toBe(1);
  expect(r.result).toMatchObject({
    status: "pending", runId: apply.id, runStatus: "queued", runUrl: `${origin}/runs/${apply.id}`,
  });
  expect(r.calls.filter(c => new URL(c.url).pathname.endsWith("/runs"))).toHaveLength(1);
  expect(r.calls.filter(c => c.method === "POST")).toHaveLength(1);
  expect(r.calls.at(-1)?.url).toBe(`${origin}/api/v1/runs/${apply.id}`);
});

test("a parked Plan is approved once and reread before applying the unchanged saved intent", async () => {
  let approved = false;
  const parked = { ...plan, status: "waiting_approval", requiresApproval: true };
  const r = await invoke(applyArgs, req => {
    if (new URL(req.url).pathname.endsWith("/approve")) { approved = true; return Response.json({ run: plan }); }
    return normal(req, { plan: approved ? plan : parked });
  });
  expect(r.code).toBe(0); expect(r.result.status).toBe("succeeded");
  expect(r.calls.filter(c => c.method === "POST").map(c => [new URL(c.url).pathname, c.redirect])).toEqual([
    [`/api/v1/runs/${plan.id}/approve`, "error"], [`/api/v1/runs/${plan.id}/apply`, "error"],
  ]);
});

test("lost approval ACK reads the exact Plan but never automatically starts Apply", async () => {
  let approved = false;
  const r = await invoke(applyArgs, req => {
    if (new URL(req.url).pathname.endsWith("/approve")) { approved = true; throw Error("synthetic lost approval ACK"); }
    return normal(req, { plan: approved ? plan : { ...plan, status: "waiting_approval" } });
  });
  expect(r.code).toBe(1); expect(r.result).toMatchObject({ status: "indeterminate", lastObservedPlanStatus: "succeeded" });
  expect(r.calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual([`/api/v1/runs/${plan.id}/approve`]);
});

test("exact retained update key survives a lost create response across manual invocations", async () => {
  const args = ["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "same-key", "--url", origin, "--token", "pat", "--json"];
  const lost = await invoke(args, () => { throw Error("synthetic lost create ACK"); });
  expect(lost.code).toBe(1); expect(lost.result.status).toBe("unconfirmed"); expect(lost.calls).toHaveLength(1);
  const retry = await invoke(args, req => new URL(req.url).pathname.endsWith("/revision-plans")
    ? Response.json({ revisionPlan: revision, nextAction: "review_run", links: {} }) : Response.json({ run: plan }));
  expect(retry.code).toBe(0);
  expect([lost.calls[0], retry.calls[0]].map(c => c!.headers.get("idempotency-key"))).toEqual(["same-key", "same-key"]);
  expect(await lost.calls[0]!.json()).toEqual(await retry.calls[0]!.json());
});

const resumeUpdateArgs = [
  "apps", "update", "cap_owned", "--ref", ref, "--revision-plan", revision.id,
  "--url", origin, "--token", "synthetic-account-pat", "--json",
];
const revisionPath = `/api/v1/revision-plans/${revision.id}`;
const revisionRunPath = `/api/v1/runs/${plan.id}`;

test("apps update resumes the exact existing coordinator without another create", async () => {
  const result = await invoke(resumeUpdateArgs, request => {
    switch (new URL(request.url).pathname) {
      case revisionPath:
        return Response.json({ revisionPlan: revision, nextAction: "reconcile" });
      case `${revisionPath}/reconcile`:
        return Response.json({ revisionPlan: revision, nextAction: "review_run" });
      case revisionRunPath:
        return Response.json({ run: plan });
      default:
        throw Error("unexpected request");
    }
  });
  expect(result.code).toBe(0);
  expect(result.result).toMatchObject({ status: "review_required", revisionPlanId: revision.id, planRunId: plan.id });
  expect(result.calls.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", revisionPath], ["POST", `${revisionPath}/reconcile`], ["GET", revisionRunPath],
  ]);
  expect(result.calls[1]!.redirect).toBe("error");
  expect(result.calls.every(request => !request.headers.has("idempotency-key"))).toBe(true);
});

test("a mismatched saved coordinator is never reconciled", async () => {
  for (const record of [
    { ...revision, id: "revision_other" },
    { ...revision, capsuleId: "cap_other" },
    { ...revision, revision: { ...revision.revision, targetRef: "release/other" } },
  ]) {
    const result = await invoke(resumeUpdateArgs, () =>
      Response.json({ revisionPlan: record, nextAction: "reconcile" }));
    expect(result.code).toBe(1);
    expect(result.result).toMatchObject({ status: "refused", code: "revision_identity_mismatch" });
    expect(result.calls.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", revisionPath],
    ]);
  }
});

test("saved coordinator mode refuses a create key and invalid IDs before HTTP", async () => {
  for (const [args, code] of [
    [[...resumeUpdateArgs, "--idempotency-key", "key"], "conflicting_modes"],
    [resumeUpdateArgs.map(value => value === revision.id ? ".." : value), "revision_plan_id_required"],
  ] as const) {
    const result = await invoke(args, () => { throw Error("must not send HTTP"); });
    expect(result.code).toBe(2);
    expect(result.result).toMatchObject({ status: "refused", code });
    expect(result.calls).toHaveLength(0);
  }
});

test("an expired saved revision Run is no longer ready for review", async () => {
  const replayArgs = [...resumeUpdateArgs];
  replayArgs.splice(5, 2, "--idempotency-key", "retained-key");
  for (const [args, firstMethod] of [[replayArgs, "POST"], [resumeUpdateArgs, "GET"]] as const) {
    const result = await invoke(args, request => new URL(request.url).pathname === revisionRunPath
      ? Response.json({ run: { ...plan, status: "expired" } })
      : Response.json({ revisionPlan: revision, nextAction: "review_run" }));
    expect(result.code).toBe(1);
    expect(result.result).toMatchObject({
      status: "plan_not_reviewable", revisionPlanId: revision.id, planRunId: plan.id, planStatus: "expired",
    });
    expect(result.result.plan).toBeUndefined();
    expect(result.calls.map(request => request.method)).toEqual([firstMethod, "GET"]);
  }
});

test("deadline covers an unfinished JSON body and no followup request occurs after abort", async () => {
  let finish: (() => void) | undefined; let sawAbort = false;
  const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "same-key", "--url", origin, "--token", "pat", "--json", "--timeout-ms", "15"], req => {
    req.signal.addEventListener("abort", () => { sawAbort = true; });
    return new Response(new ReadableStream({ start(controller) { finish = () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ revisionPlan: revision, nextAction: "review_run", links: {} })));
      controller.close();
    }; } }));
  });
  expect(r.code).toBe(1); expect(r.result.status).toBe("unconfirmed"); expect(sawAbort).toBe(true);
  finish?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(r.calls).toHaveLength(1);
});

test("credentials embedded in an origin are refused without disclosure or HTTP", async () => {
  const args = applyArgs.map(s => s === origin ? "https://synthetic-user:synthetic-password@takosumi.example.test" : s);
  const r = await invoke(args, () => { throw Error("no HTTP"); });
  expect(r.code).toBe(2); expect(r.calls).toHaveLength(0);
  expect(JSON.stringify(r.result)).not.toContain("synthetic-password");
});

test("coordinator evidence and Plan projection must match, and post-create uncertainty is retained", async () => {
  for (const change of [
    { workspaceId: "other" }, { baseStateGeneration: 2 }, { sourceSnapshotId: "other" },
    { sourceSnapshotId: { password: "synthetic-private-must-not-print" } },
    { policyStatus: { password: "synthetic-private-must-not-print" } },
  ]) {
    const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "fixed", "--url", origin, "--token", "pat", "--json"], req =>
      new URL(req.url).pathname.endsWith("/revision-plans") ? Response.json({ revisionPlan: revision, nextAction: "review_run", links: {} }) : Response.json({ run: { ...plan, ...change } }));
    expect(r.code).toBe(1); expect(r.result.status).toBe("unconfirmed");
    expect(JSON.stringify(r.result)).not.toContain("synthetic-private-must-not-print");
  }
});

test("conflicting observation and execution modes refuse before HTTP", async () => {
  const r = await invoke([...applyArgs, "--observe-only"], () => { throw Error("must not request"); });
  expect(r.code).toBe(2); expect(r.calls).toHaveLength(0);
});

test("late capsule JSON cannot approve or print a review after the command deadline", async () => {
  let finish: (() => void) | undefined;
  const r = await invoke([...applyArgs, "--timeout-ms", "15"], req => {
    if (new URL(req.url).pathname === "/api/v1/capsules/cap_owned") return new Response(new ReadableStream({ start(c) { finish = () => {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ capsule }))); c.close();
    }; } }));
    return normal(req, { plan: { ...plan, status: "waiting_approval" } });
  });
  finish?.(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(r.code).toBe(1); expect(r.calls.filter(c => c.method === "POST")).toHaveLength(0);
  expect(r.err).toHaveLength(0);
});

test("credential and target selection stay fixed across asynchronous coordinator reads", async () => {
  const oldToken = process.env.TAKOSUMI_ACCOUNT_TOKEN; const oldUrl = process.env.TAKOSUMI_DEPLOY_CONTROL_URL;
  process.env.TAKOSUMI_ACCOUNT_TOKEN = "synthetic-original-pat"; process.env.TAKOSUMI_DEPLOY_CONTROL_URL = origin;
  try {
    const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key=stable-key", "--json"], req => {
      if (new URL(req.url).pathname.endsWith("/revision-plans")) {
        process.env.TAKOSUMI_ACCOUNT_TOKEN = "synthetic-replacement-pat"; process.env.TAKOSUMI_DEPLOY_CONTROL_URL = "https://other.example.test";
        return Response.json({ revisionPlan: revision, nextAction: "review_run", links: {} });
      }
      return Response.json({ run: plan });
    });
    expect(r.code).toBe(0); expect(r.calls.length).toBeGreaterThan(1);
    expect(r.calls.every(c => c.headers.get("authorization") === "Bearer synthetic-original-pat" && new URL(c.url).origin === origin)).toBe(true);
    expect(r.result.reviewUrl).toBe(`${origin}/runs/${plan.id}`);
  } finally {
    if (oldToken === undefined) delete process.env.TAKOSUMI_ACCOUNT_TOKEN; else process.env.TAKOSUMI_ACCOUNT_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.TAKOSUMI_DEPLOY_CONTROL_URL; else process.env.TAKOSUMI_DEPLOY_CONTROL_URL = oldUrl;
  }
});

test.each(["reconcile_in_progress", "reconcile_conflict"] as const)("a post-create %s preserves the durable coordinator as unconfirmed", async conflict => {
  for (const observation of ["pending", "different-id", "forbidden"] as const) {
    const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "fixed", "--url", origin, "--token", "pat", "--json"], req => {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/capsules/cap_owned/revision-plans") {
        return Response.json({ revisionPlan: revision, nextAction: "reconcile", links: {} });
      }
      if (req.method === "POST") return Response.json({ error: { code: conflict } }, { status: 409 });
      if (observation === "forbidden") return Response.json({ error: { code: "forbidden" } }, { status: 403 });
      const observed = observation === "different-id" ? { ...revision, id: "rev_wrong" } : revision;
      return Response.json({ revisionPlan: observed, nextAction: "reconcile", links: {} });
    });
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ status: "unconfirmed", revisionPlanId: revision.id,
      code: observation === "different-id" ? "revision_identity_mismatch" : conflict });
    expect(r.calls.map(req => `${req.method} ${new URL(req.url).pathname}`)).toEqual([
      "POST /api/v1/capsules/cap_owned/revision-plans",
      `POST /api/v1/revision-plans/${revision.id}/reconcile`,
      `GET /api/v1/revision-plans/${revision.id}`,
    ]);
  }
});
