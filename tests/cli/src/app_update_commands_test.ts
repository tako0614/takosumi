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

async function invoke(args: string[], handle: (req: Request) => Promise<Response> | Response) {
  const before = globalThis.fetch; const calls: Request[] = []; const out: string[] = []; const err: string[] = [];
  globalThis.fetch = (async (input, init) => { const req = new Request(input, init); calls.push(req); return await handle(req); }) as typeof fetch;
  try {
    const code = await main(args, { stdout: s => out.push(s), stderr: s => err.push(s) });
    return { code, calls, result: out.length ? JSON.parse(out.join("\n")) : undefined, err };
  } finally { globalThis.fetch = before; }
}
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
  throw Error("unexpected fixture request");
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
    expect(calls.filter(c => c.method === "POST").map(c => new URL(c.url).pathname)).toEqual([`/api/v1/runs/${plan.id}/apply`]);
  } finally { globalThis.fetch = before; }
});

test("new commands reject absent, ambiguous and unknown mutation flags before HTTP", async () => {
  for (const args of [
    ["apps", "update", "cap_owned", "--ref", ref],
    ["apps", "update", "cap_owned", "--ref", "--idempotency-key", "key"],
    ["apps", "update", "cap_owned", "--ref", ref, "--idempotency-key", "key", "--apply"],
    ["apps", "update", "cap_owned", "--ref", ref, "--ref", "different", "--idempotency-key", "key"],
    ["apps", "apply", "cap_owned", "--plan", plan.id],
    ["apps", "apply", "cap_owned", "--plan", plan.id, "--yes=true"],
    ["apps", "apply", "cap_owned", "--plan", plan.id, "--yes", "extra"],
    [...applyArgs, "--timeout-ms", "0"],
  ]) {
    const result = await invoke(args, () => { throw Error("HTTP must not be reached"); });
    expect(result.code).toBe(2); expect(result.calls).toHaveLength(0);
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
