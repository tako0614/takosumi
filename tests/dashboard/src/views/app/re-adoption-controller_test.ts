import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ControlApiError, getCapsuleApp, getCapsuleInstallConfigReAdoptionContext, isRevisionAlreadyCurrent } from "../../../../../dashboard/src/lib/control-api.ts";
import { buildReAdoptionInputs, initialReAdoptionDrafts, reAdoptionRevisionFromError } from "../../../../../dashboard/src/lib/re-adoption-inputs.ts";
import { createReAdoptionPlanSubmission } from "../../../../../dashboard/src/lib/re-adoption-plan.ts";
import { reAdoptionContext } from "../../../fixtures/re-adoption-context.ts";

const root = new URL("../../../../../", import.meta.url);
// Resolve the UI's declared dependency from its own package, not root deps.
const { createRoot, createSignal, onCleanup } = createRequire(new URL("dashboard/package.json", root))("solid-js");
const page = readFileSync(new URL("dashboard/src/views/app/AppManagePage.tsx", root), "utf8");
const form = readFileSync(new URL("dashboard/src/views/app/AppReAdoptionInputs.tsx", root), "utf8");
function between(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("actual controller boundary changed");
  return source.slice(from, to);
}
const transpile = (source: string) => new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
const startSource = between(page, "  const startReview = async (", "\n  // After a review ends");
const formSource = between(form, "  const [context, setContext]", "\n  return (");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function controllers() {
  let target: string | undefined, review: { planRunId: string } | undefined;
  let starting: unknown;
  const scope = { capsuleId: "capsule_a", revisionPlanId: "revision_failed", principalId: "person_a", busy: false };
  const startReview = new Function("capsuleId", "capsule", "props", "reviewBusy", "appRole", "isOwner", "setStarting", "setSectionError", "setNotice", "setReview", "setReAdoptionRevisionId", "reAdoptionRevisionFromError", "isRevisionAlreadyCurrent", "friendlyError", "t", "queueMicrotask", "disposed", "ControlApiError", "refetchApp", "reviewScopeEpoch", "starting", "review", `${transpile(startSource)}; return startReview;`)(
    () => scope.capsuleId, () => ({ sourceId: "source_a" }), scope, () => scope.busy, () => "owner", () => true,
    (value: unknown) => { starting = value; scope.busy = value !== undefined; }, () => {}, () => {},
    (value: { planRunId: string }) => { review = value; }, (value: string) => { target = value; },
    reAdoptionRevisionFromError, isRevisionAlreadyCurrent, () => ({ message: "fixture error" }), (key: string) => key, () => {},
    false, ControlApiError, () => getCapsuleApp(scope.capsuleId), 0, () => starting, () => review,
  ) as (section: string, purpose: string, create: () => Promise<string>) => Promise<void>;
  let dispose!: () => void;
  const formProps = {
    get capsuleId() { return scope.capsuleId; }, get revisionPlanId() { return scope.revisionPlanId; },
    get principalId() { return scope.principalId; }, get busy() { return scope.busy; },
    onReview: (create: () => Promise<string>) => startReview("version", "update", create), onChanged() {},
  };
  const controller = createRoot((cleanup: () => void) => {
    dispose = cleanup;
    return new Function("props", "createSignal", "onCleanup", "getCapsuleInstallConfigReAdoptionContext", "friendlyError", "t", "buildReAdoptionInputs", "initialReAdoptionDrafts", "createReAdoptionPlanSubmission", "ControlApiError", "reAdoptionRevisionFromError", `${transpile(formSource)}; return { read, submit, edit, context, currentContext, drafts, operation, canRead };`)(
      formProps, createSignal, onCleanup, getCapsuleInstallConfigReAdoptionContext, () => ({ message: "fixture error" }), (key: string) => key,
      buildReAdoptionInputs, initialReAdoptionDrafts, createReAdoptionPlanSubmission, ControlApiError, reAdoptionRevisionFromError,
    );
  });
  return { scope, startReview, controller, target: () => target, review: () => review, dispose };
}

function failedTarget() {
  return { nextAction: "failed", revisionPlan: { id: "revision_failed", operation: "revision", capsuleId: "capsule_a", sourceId: "source_a",
    phase: "failed", sourceSnapshotId: "snapshot_two", revision: { targetRef: "release/v2" } } };
}
function adoption() {
  return { capsule: { id: "capsule_a", installConfigId: "config_target", currentStateGeneration: 4, currentStateVersionId: "state_four" },
    installConfigReAdoption: { sourceSnapshotId: "snapshot_two", targetInstallConfigId: "config_target" } };
}
function planned() {
  return { nextAction: "review_run", revisionPlan: { id: "revision_new", operation: "revision", capsuleId: "capsule_a", sourceId: "source_a",
    phase: "review_ready", planRunId: "plan_target", sourceSnapshotId: "snapshot_two", revision: { targetRef: "release/v2",
      base: { installConfigId: "config_target", capsuleStateGeneration: 4, capsuleStateVersionId: "state_four" } } } };
}

test("actual page failure opens target inputs and explicit form submission reaches only the matching Plan review", async () => {
  const state = controllers();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET") return json({ installConfigReAdoptionContext: reAdoptionContext() });
    if (path.endsWith("/install-config-re-adoptions")) return json(adoption());
    if (path.endsWith("/revision-plans")) return json(planned(), 201);
    throw new Error("unexpected request");
  }) as typeof fetch;
  try {
    await state.startReview("version", "update", async () => { throw new ControlApiError(409, "plan_run_failed", "fixture", failedTarget()); });
    expect(state.target()).toBe("revision_failed");
    expect(state.review()).toBeUndefined();
    expect(page).toContain("const target = reAdoptionRevisionFromError(cause, forCapsule, capsule()?.sourceId)");
    expect(page).toContain("<AppReAdoptionInputs");
    expect(page).toContain('onReview={create => startReview("version", "update", create, { restartable: false })}');
    await state.controller.read();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/v1/capsules/capsule_a/install-config-re-adoption-context?revisionPlanId=revision_failed");
    await state.controller.submit();
    expect(calls).toHaveLength(1); // required field is still unanswered
    state.controller.edit("release_note", { mode: "set", text: "fixture-note" });
    await state.controller.submit();
    expect(state.review()?.planRunId).toBe("plan_target");
    expect(calls[1]!.body).toEqual({ baseInstallConfigId: "generic_service", sourceSnapshotId: "snapshot_two", reason: "Review declared target user inputs",
      reviewedUserVariables: { release_note: "fixture-note", optional_flag: false, empty_value: "", json_value: null }, expected: { authorityGuard: "fixture-current-guard" } });
    expect(calls[2]!.body).toEqual({ ref: "release/v2" });
    expect(calls).toHaveLength(3);
    expect(calls.some(call => /\/(apply|approve)$/.test(call.path))).toBe(false);
  } finally { state.dispose(); }
});

test("actual form drops a late context for another person and never automatically sends an answer", async () => {
  const state = controllers();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; await ready; return json({ installConfigReAdoptionContext: reAdoptionContext() }); }) as typeof fetch;
  try {
    const read = state.controller.read();
    state.scope.principalId = "person_b";
    release(); await read;
    expect(state.controller.context()).toBeUndefined();
    await state.controller.submit();
    expect(calls).toBe(1);
  } finally { state.dispose(); }
});

test("only a structured failed same-app source revision can open the input context", () => {
  const body = failedTarget();
  expect(reAdoptionRevisionFromError(new ControlApiError(409, "plan_run_failed", "fixture", body), "capsule_a", "source_a")).toBe("revision_failed");
  for (const bad of [
    { ...body, revisionPlan: { ...body.revisionPlan, operation: "install" } },
    { ...body, revisionPlan: { ...body.revisionPlan, capsuleId: "capsule_b" } },
    { ...body, revisionPlan: { ...body.revisionPlan, sourceId: "source_b" } },
    { ...body, revisionPlan: { ...body.revisionPlan, sourceSnapshotId: undefined } },
    { ...body, revisionPlan: { ...body.revisionPlan, id: "" } },
    { ...body, revisionPlan: { ...body.revisionPlan, phase: "planning" } },
    { message: "revision_failed" },
  ]) expect(reAdoptionRevisionFromError(new ControlApiError(409, "plan_run_failed", "fixture", bad), "capsule_a", "source_a")).toBeUndefined();
  expect(reAdoptionRevisionFromError(new Error("revision_failed"), "capsule_a", "source_a")).toBeUndefined();
});

test("actual form permits reread only for closed no-rebind outcomes and retains uncertain answers", async () => {
  for (const reason of ["capsule_install_config_rebind_conflict", "capsule_install_config_rebind_busy", "activity_failed", undefined]) {
    const state = controllers();
    const posts: Array<{ key: string | null; body: string }> = [];
    let reads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        reads++;
        return json({ installConfigReAdoptionContext: reAdoptionContext() });
      }
      posts.push({ key: new Headers(init?.headers).get("idempotency-key"), body: String(init?.body) });
      return json({ error: { code: "failed_precondition", message: "fixture rejected", details: { ...(reason ? { reason } : {}) } } }, 409);
    }) as typeof fetch;
    try {
      await state.controller.read();
      state.controller.edit("release_note", { mode: "set", text: "fixture-note" });
      await state.controller.submit();
      const closed = reason === "capsule_install_config_rebind_conflict" || reason === "capsule_install_config_rebind_busy";
      expect(Boolean(state.controller.canRead())).toBe(closed);
      const original = state.controller.operation();
      await state.controller.read();
      expect(reads).toBe(closed ? 2 : 1);
      if (closed) expect(state.controller.operation()).toBeUndefined();
      else {
        expect(state.controller.operation()).toBe(original);
        state.controller.edit("release_note", { mode: "set", text: "must-not-replace" });
        await state.controller.submit();
        expect(posts).toHaveLength(2);
        expect(posts[1]).toEqual(posts[0]);
      }
    } finally { state.dispose(); }
  }
});

test("a moved named ref never opens its different Plan and needs an explicit target reread", async () => {
  const state = controllers();
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if ((init?.method ?? "GET") === "GET") {
      const context = reAdoptionContext();
      if (calls > 3) { context.revisionPlanId = "revision_new"; context.sourceSnapshotId = "snapshot_moved"; }
      return json({ installConfigReAdoptionContext: context });
    }
    if (calls === 2) return json(adoption());
    const result = planned();
    result.revisionPlan.sourceSnapshotId = "snapshot_moved";
    return json(result);
  }) as typeof fetch;
  try {
    await state.controller.read();
    state.controller.edit("release_note", { mode: "set", text: "fixture-note" });
    await state.controller.submit();
    expect(state.review()).toBeUndefined();
    expect(state.target()).toBe("revision_new");
    expect(state.controller.operation().adoptionAcknowledged()).toBe(true);
    expect(Boolean(state.controller.canRead())).toBe(true);
    expect(calls).toBe(3);
    state.scope.revisionPlanId = state.target()!;
    await state.controller.read();
    expect(state.controller.context().sourceSnapshotId).toBe("snapshot_moved");
    expect(state.controller.operation()).toBeUndefined();
    expect(calls).toBe(4);
  } finally { state.dispose(); }
});

test("a read context cannot supply another person's explicit answer", async () => {
  const state = controllers();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return json({ installConfigReAdoptionContext: reAdoptionContext() }); }) as typeof fetch;
  try {
    await state.controller.read();
    state.controller.edit("release_note", { mode: "set", text: "fixture-note" });
    state.scope.principalId = "person_b";
    expect(state.controller.currentContext()).toBeUndefined();
    await state.controller.submit();
    expect(calls).toBe(1);
  } finally { state.dispose(); }
});
