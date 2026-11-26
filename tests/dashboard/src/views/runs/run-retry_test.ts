/**
 * "Try again" plans a failed run again as the same change it was made for,
 * on the run page and the app page alike — never whatever the Source's
 * default ref holds for an installed app.
 */
import { describe, expect, test } from "bun:test";
import {
  defaultRetryPlanApi,
  retryChangeForRun,
  retryPlanForRun,
  type RetryPlanApi,
} from "../../../../../dashboard/src/lib/run-retry.ts";
import type { Capsule, Run } from "../../../../../dashboard/src/lib/control-api.ts";

function recorder(runs: Readonly<Record<string, Run>> = {}) {
  const calls: string[] = [];
  const api: RetryPlanApi = {
    getRun: async (id) => {
      calls.push(`read ${id}`);
      const found = runs[id];
      if (!found) throw new Error(`no run ${id}`);
      return found;
    },
    destroyPlanCapsule: async (id) => { calls.push(`destroy ${id}`); return { run: { id: "run_destroy" } }; },
    planCapsule: async (id, options) => { calls.push(`plan ${id} ${options.compatibilityReportId}`); return { run: { id: "run_plan" } }; },
    planRevision: async (id, ref) => { calls.push(`revision ${id} ${ref}`); return "run_revision"; },
    planRollback: async (stateVersionId) => { calls.push(`rollback ${stateVersionId}`); return { run: { id: "run_rollback" } }; },
    planTracked: async (id) => { calls.push(`tracked ${id}`); return { run: { id: "run_tracked" } }; },
  };
  return { api, calls };
}

const capsule = (patch: Partial<Capsule> = {}): Capsule => ({
  id: "cap_a", workspaceId: "ws_a", name: "a", slug: "a", installConfigId: "cfg_a",
  environment: "production", currentStateGeneration: 2, currentStateVersionId: "sv_2",
  status: "error", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  ...patch,
});
const run = (patch: Partial<Run>): Run => ({
  id: "run_failed", workspaceId: "ws_a", capsuleId: "cap_a", type: "apply", status: "failed",
  createdBy: "sub", createdAt: "2026-10-02T00:00:00Z", baseStateGeneration: 2, ...patch,
});
const plan = (origin: Run["origin"]): Run =>
  run({ id: "run_plan_failed", type: "plan", status: "succeeded", ...(origin ? { origin } : {}) });

describe("retryPlanForRun", () => {
  test("keeps a rollback attempt until the active view receives a Plan id", async () => {
    const realFetch = globalThis.fetch;
    const prior = run({ type: "plan", origin: { kind: "rollback", stateVersionId: "sv_1" } });
    const api = defaultRetryPlanApi();
    const keys: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/v1/state-versions/sv_1/rollback-plan");
      expect(init?.method).toBe("POST");
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return Response.json(keys.length === 1 ? {} : { run: { id: `plan_${keys.length}` } });
    }) as typeof fetch;
    try {
      expect(await api.planRollback("sv_1", () => false)).toBeUndefined();
      expect(keys).toEqual([]);
      expect(await retryPlanForRun(prior, capsule(), api)).toBeUndefined();
      expect(await retryPlanForRun(prior, capsule(), api)).toBe("plan_2");
      expect(await retryPlanForRun(prior, capsule(), api)).toBe("plan_3");
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).toBeTruthy();
      expect(keys[2]).not.toBe(keys[0]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("restores a failed Run's attempt only for the same account, Run, and state after reload", async () => {
    const realFetch = globalThis.fetch;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storage = new Map<string, string>();
    let storageAvailable = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: {
        getItem: (key: string) => {
          if (!storageAvailable) throw new Error("storage unavailable");
          return storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (!storageAvailable) throw new Error("storage unavailable");
          storage.set(key, value);
        },
        removeItem: (key: string) => storage.delete(key),
      } },
    });
    const prior = run({ type: "plan", origin: { kind: "rollback", stateVersionId: "sv_1" } });
    const api = (subject = "sub_a", account = "acc_a", runId = prior.id) =>
      defaultRetryPlanApi(undefined, undefined, () => [subject, account, runId]);
    const keys: (string | null)[] = [];
    const plans = new Map<string | null, string>();
    let loseAck = true;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("idempotency-key");
      keys.push(key);
      const id = plans.get(key) ?? `plan_${plans.size + 1}`;
      plans.set(key, id);
      if (loseAck) {
        loseAck = false;
        return Response.json({}, { status: 502 });
      }
      return Response.json({ run: { id } }, { status: 201 });
    }) as typeof fetch;
    try {
      await expect(retryPlanForRun(prior, capsule(), api())).rejects.toMatchObject({ status: 502 });
      expect(keys[0]).toBeTruthy();
      expect(storage.size).toBe(1);
      expect(await retryPlanForRun(prior, capsule(), api("sub_b"))).toBe("plan_2");
      expect(await retryPlanForRun(prior, capsule(), api("sub_a", "acc_b"))).toBe("plan_3");
      expect(await retryPlanForRun(prior, capsule(), api("sub_a", "acc_a", "run_other"))).toBe("plan_4");
      expect(await retryPlanForRun(prior, capsule({ currentStateVersionId: "sv_3" }), api())).toBe("plan_5");
      expect(storage.size).toBe(1);
      expect(await retryPlanForRun(prior, capsule(), api())).toBe("plan_1");
      expect(keys.at(-1)).toBe(keys[0]);
      expect(storage.size).toBe(0);
      expect(await retryPlanForRun(prior, capsule(), api())).toBe("plan_6");

      // If storage recovers, the attempt already sent by this view still owns
      // the retry, even if a previous view left a different key in storage.
      loseAck = true;
      await expect(retryPlanForRun(prior, capsule(), api())).rejects.toMatchObject({ status: 502 });
      expect(storage.size).toBe(1);
      storageAvailable = false;
      const mounted = api();
      loseAck = true;
      await expect(retryPlanForRun(prior, capsule(), mounted)).rejects.toMatchObject({ status: 502 });
      const activeKey = keys.at(-1);
      expect(activeKey).not.toBe([...storage.values()][0]);
      storageAvailable = true;
      expect(await retryPlanForRun(prior, capsule(), mounted)).toBe("plan_8");
      expect(keys.at(-1)).toBe(activeKey);
      expect(storage.size).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("reuses the exact revision request after its create response is lost", async () => {
    const realFetch = globalThis.fetch;
    const prior = run({ type: "plan", origin: { kind: "revision", ref: "release/v3" } });
    const api = defaultRetryPlanApi();
    const requests: { key: string | null; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/v1/capsules/cap_a/revision-plans");
      const key = new Headers(init?.headers).get("idempotency-key");
      requests.push({ key, body: JSON.parse(String(init?.body)) });
      if (requests.length === 1) throw new Error("create response was lost");
      if (requests.length === 2 && key !== requests[0]?.key) {
        return Response.json({ error: { code: "failed_precondition", message: "revision_in_progress" } }, { status: 409 });
      }
      return Response.json({
        revisionPlan: {
          id: "grp_recovered", capsuleId: "cap_a", revision: { targetRef: "release/v3" },
          phase: "reviewable", planRunId: "plan_recovered",
        },
        nextAction: "review_run", links: { self: "/api/v1/revision-plans/grp_recovered" },
      });
    }) as typeof fetch;
    try {
      await expect(retryPlanForRun(prior, capsule(), api)).rejects.toThrow("create response was lost");
      expect(await retryPlanForRun(prior, capsule(), api)).toBe("plan_recovered");
      expect(requests[0]?.key).toBeTruthy();
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]?.body).toEqual({ ref: "release/v3" });
      await retryPlanForRun(prior, capsule(), api);
      expect(requests[2]?.key).not.toBe(requests[0]?.key);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("starts a new revision attempt after the acknowledged coordinator fails", async () => {
    const realFetch = globalThis.fetch;
    const prior = run({ type: "plan", origin: { kind: "revision", ref: "release/v3" } });
    const api = defaultRetryPlanApi();
    const keys: (string | null)[] = [];
    const created = { id: "grp_failed", capsuleId: "cap_a", revision: { targetRef: "release/v3" }, phase: "planning" };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/revision-plans/grp_failed/reconcile") {
        return Response.json({
          revisionPlan: { ...created, phase: "failed", diagnostic: { code: "revision_plan_failed" } },
          nextAction: "none", links: { self: "/api/v1/revision-plans/grp_failed" },
        });
      }
      expect(String(input)).toBe("/api/v1/capsules/cap_a/revision-plans");
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      if (keys.length === 1) return Response.json({ revisionPlan: created, nextAction: "reconcile", links: {} });
      return Response.json({
        revisionPlan: { ...created, id: "grp_new", phase: "reviewable", planRunId: "plan_new" },
        nextAction: "review_run", links: {},
      });
    }) as typeof fetch;
    try {
      await expect(retryPlanForRun(prior, capsule(), api)).rejects.toMatchObject({ code: "revision_plan_failed" });
      expect(await retryPlanForRun(prior, capsule(), api)).toBe("plan_new");
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBeTruthy();
      expect(keys[1]).not.toBe(keys[0]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a retry whose Run page has retired stops after reading the original Plan", async () => {
    const { api, calls } = recorder({ run_plan_failed: plan({ kind: "revision", ref: "v2" }) });
    expect(await retryPlanForRun(run({ planRunId: "run_plan_failed" }), capsule(), api, () => false)).toBeUndefined();
    expect(calls).toEqual(["read run_plan_failed"]);
  });

  test.each(["apply", "destroy_apply"] as const)(
    "an indeterminate %s cannot start a replacement Plan",
    async type => {
      const { api, calls } = recorder();
      const failure = run({ type, errorCode: "runner_mutation_indeterminate" });
      await expect(retryPlanForRun(failure, capsule(), api)).rejects.toMatchObject({
        code: "runner_mutation_indeterminate",
      });
      expect(calls).toEqual([]);
    },
  );

  test("an Apply with unpublished outputs requires state recovery before retry", async () => {
    const { api, calls } = recorder();
    const failure = run({ type: "apply", errorCode: "apply_output_projection_failed" });
    await expect(retryPlanForRun(failure, capsule(), api)).rejects.toMatchObject({
      code: "apply_output_projection_failed",
    });
    expect(calls).toEqual([]);
  });

  test("a failed removal is retried as a removal", async () => {
    for (const type of ["destroy_plan", "destroy_apply"] as const) {
      const { api, calls } = recorder();
      expect(await retryPlanForRun(run({ type }), capsule(), api)).toBe("run_destroy");
      expect(calls).toEqual(["destroy cap_a"]);
    }
  });

  test("a failed version change plans the same ref again, never the default ref", async () => {
    const { api, calls } = recorder({ run_plan_failed: plan({ kind: "revision", ref: "v2" }) });
    expect(await retryPlanForRun(run({ planRunId: "run_plan_failed" }), capsule(), api)).toBe("run_revision");
    expect(calls).toEqual(["read run_plan_failed", "revision cap_a v2"]);
  });

  test("a failed rollback goes back to the same version again", async () => {
    const { api, calls } = recorder({ run_plan_failed: plan({ kind: "rollback", stateVersionId: "sv_1" }) });
    expect(await retryPlanForRun(run({ planRunId: "run_plan_failed" }), capsule(), api)).toBe("run_rollback");
    expect(calls).toEqual(["read run_plan_failed", "rollback sv_1"]);
  });

  test("a failed Workspace update plans the tracked ref again", async () => {
    const { api, calls } = recorder({ run_plan_failed: plan({ kind: "update" }) });
    expect(await retryPlanForRun(run({ planRunId: "run_plan_failed" }), capsule(), api)).toBe("run_tracked");
    expect(calls).toEqual(["read run_plan_failed", "tracked cap_a"]);
  });

  test("a policy-blocked plan repeats its own change", async () => {
    const { api, calls } = recorder();
    await retryPlanForRun(run({ type: "plan", status: "succeeded", origin: { kind: "revision", ref: "release/v3" } }), capsule(), api);
    expect(calls).toEqual(["revision cap_a release/v3"]);
  });

  test("a failed settings change, or a plan with no recorded origin, re-plans the installed version as configured", async () => {
    const { api, calls } = recorder({
      run_settings: { ...plan({ kind: "configuration" }), id: "run_settings" },
      run_legacy: { ...plan(undefined), id: "run_legacy" },
    });
    await retryPlanForRun(run({ planRunId: "run_settings" }), capsule(), api);
    await retryPlanForRun(run({ planRunId: "run_legacy" }), capsule(), api);
    await retryPlanForRun(run({}), capsule(), api);
    expect(calls).toEqual(["read run_settings", "rollback sv_2", "read run_legacy", "rollback sv_2", "rollback sv_2"]);
    // Only a recorded configuration change is a retry of that change; a plan
    // without an origin is a re-plan of the installed version, labelled so.
    expect(retryChangeForRun({ run: run({}), plan: { ...plan({ kind: "configuration" }) }, capsule: capsule() }))
      .toEqual({ kind: "installed", stateVersionId: "sv_2", recorded: true });
    expect(retryChangeForRun({ run: run({}), plan: plan(undefined), capsule: capsule() }))
      .toEqual({ kind: "installed", stateVersionId: "sv_2", recorded: false });
  });

  test("a first install keeps its exact reviewed report", async () => {
    const { api, calls } = recorder();
    await retryPlanForRun(
      run({ type: "apply", baseStateGeneration: 0, compatibilityReportId: "rep_initial" }),
      capsule({ currentStateGeneration: 0, currentStateVersionId: undefined, status: "pending" }),
      api,
    );
    expect(calls).toEqual(["plan cap_a rep_initial"]);
  });

  test("refuses a run from another app or workspace, a stale first-install plan, and an app with no installed version", async () => {
    const { api, calls } = recorder();
    await expect(retryPlanForRun(run({ capsuleId: "cap_b" }), capsule(), api)).rejects.toMatchObject({ code: "retry_plan_identity_mismatch" });
    await expect(retryPlanForRun(run({ workspaceId: "ws_b" }), capsule(), api)).rejects.toMatchObject({ code: "retry_plan_identity_mismatch" });
    await expect(
      retryPlanForRun(run({ type: "plan", baseStateGeneration: 0 }), capsule(), api),
    ).rejects.toMatchObject({ code: "retry_plan_review_mismatch" });
    expect(() =>
      retryChangeForRun({ run: run({}), capsule: capsule({ currentStateVersionId: undefined }) }),
    ).toThrow();
    expect(calls).toEqual([]);
  });
});
