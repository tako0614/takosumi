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
  expect(r.calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-account-pat");
  expect(await r.calls[0]!.json()).toEqual({ destroyProviderConnectionReplacements: destroyPairs });
});

test("recover-uninstall rejects malformed pairs and confirmation flags before HTTP", async () => {
  for (const pairs of [
    "not-json", "{}", "[]", "[{}]",
    JSON.stringify([{ connectionId: "conn_old_a", replacementConnectionId: "conn_old_a" }]),
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
    [...recoverArgs, "--destroy-plan", destroyPlan.id],
    [...reviewDestroyArgs, "--yes"],
    reviewDestroyArgs.map(value => value === destroyPlan.id ? " " : value),
  ]) {
    const r = await invoke(args, () => { throw Error("must not send recovery HTTP"); });
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
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

test("recover-uninstall distinguishes the three confirmed replacement connection refusals", async () => {
  for (const connectionRecoveryFailure of [
    "replacement_unverified", "bindings_mismatch", "applied_evidence_unavailable",
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

test("a parked Plan is approved once and reread before applying the unchanged saved intent", async () => {
  let approved = false;
  const parked = { ...plan, status: "waiting_approval", requiresApproval: true };
  const r = await invoke(applyArgs, req => {
    if (new URL(req.url).pathname.endsWith("/approve")) { approved = true; return Response.json({ run: plan }); }
    return normal(req, { plan: approved ? plan : parked });
  });
  expect(r.code).toBe(0); expect(r.result.status).toBe("succeeded");
  expect(r.calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual([
    `/api/v1/runs/${plan.id}/approve`, `/api/v1/runs/${plan.id}/apply`,
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

test("a post-create reconcile conflict preserves the durable coordinator as unconfirmed", async () => {
  let count = 0;
  const r = await invoke(["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "fixed", "--url", origin, "--token", "pat", "--json"], () => {
    count++;
    return count === 1 ? Response.json({ revisionPlan: revision, nextAction: "reconcile", links: {} })
      : Response.json({ error: { code: "reconcile_in_progress" } }, { status: 409 });
  });
  expect(r.code).toBe(1);
  expect(r.result).toMatchObject({ status: "unconfirmed", revisionPlanId: revision.id, code: "reconcile_in_progress" });
  expect(r.calls).toHaveLength(2);
});
