import { afterEach, describe, expect, test } from "bun:test";

import {
  awaitsDeployApproval,
  canApproveRun,
  isDeployApprovalCandidate,
  isReviewRun,
} from "../../../../dashboard/src/lib/run-approval.ts";
import { approveRun, type Run } from "../../../../dashboard/src/lib/control-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function planRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_plan",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    type: "plan",
    status: "succeeded",
    policyStatus: "pass",
    createdBy: "user_1",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Run;
}

function applyRun(overrides: Partial<Run> = {}): Run {
  return planRun({
    id: "run_apply",
    planRunId: "run_plan",
    type: "apply",
    createdAt: "2026-07-01T00:05:00.000Z",
    ...overrides,
  });
}

describe("shared deploy-approval predicate (run list ↔ run view)", () => {
  test("explicit approval accepts waiting Plans and leaves old Restore Runs as history", () => {
    expect(canApproveRun(planRun({ status: "waiting_approval" }))).toBe(true);
    expect(canApproveRun(planRun({ type: "destroy_plan", status: "waiting_approval" }))).toBe(true);
    expect(canApproveRun(planRun({ type: "restore", status: "waiting_approval" }))).toBe(false);
    expect(canApproveRun(planRun())).toBe(false);
  });

  test("a succeeded policy-pass plan with no later apply awaits approval", () => {
    const plan = planRun();
    expect(isReviewRun(plan)).toBe(true);
    expect(isDeployApprovalCandidate(plan)).toBe(true);
    expect(awaitsDeployApproval(plan, [plan])).toBe(true);
  });

  test("an exact linked apply consumes the approval — even when failed", () => {
    const plan = planRun();
    expect(awaitsDeployApproval(plan, [plan, applyRun()])).toBe(false);
    expect(
      awaitsDeployApproval(plan, [plan, applyRun({ status: "failed" })]),
    ).toBe(false);
    // destroy_apply counts as the corresponding apply of a destroy_plan.
    const destroyPlan = planRun({ type: "destroy_plan" });
    expect(
      awaitsDeployApproval(destroyPlan, [
        destroyPlan,
        applyRun({ type: "destroy_apply" }),
      ]),
    ).toBe(false);
  });

  test("only an exact planRunId consumes approval", () => {
    const plan = planRun();
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({ capsuleId: "capsule_other" }),
        applyRun({ planRunId: "run_plan_other" }),
      ]),
    ).toBe(true);
    expect(
      awaitsDeployApproval(plan, [plan, applyRun({ planRunId: undefined })]),
    ).toBe(true);
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({
          planRunId: "run_plan",
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(false);
  });

  test("non-candidates never await approval", () => {
    expect(awaitsDeployApproval(planRun({ status: "failed" }), [])).toBe(false);
    expect(awaitsDeployApproval(planRun({ policyStatus: "blocked" }), [])).toBe(
      false,
    );
    expect(awaitsDeployApproval(applyRun(), [])).toBe(false);
    // No resolvable capsule: nothing to key the sibling scan on.
    expect(awaitsDeployApproval(planRun({ capsuleId: undefined }), [])).toBe(
      false,
    );
  });

  test("legacy or missing relation fails closed without a timestamp guess", () => {
    const plan = planRun({ createdAt: "not-a-date" });
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({
          planRunId: undefined,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(true);
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({
          planRunId: "legacy_unknown",
          createdAt: "2030-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(true);
  });
});

describe("readback after approving a reviewed Plan", () => {
  const reviewed = planRun({ status: "waiting_approval", planDigest: "sha256:reviewed", baseStateGeneration: 1 });
  const approved = { ...reviewed, status: "succeeded" } as const;
  const approvalPath = "/api/v1/runs/run_plan/approve";
  const runPath = "/api/v1/runs/run_plan";

  test.each(["matching approval", "bad gateway", "transport error", "mismatched approval"] as const)(
    "%s only accepts the exact approved Plan",
    async (scenario) => {
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        calls.push(`${init?.method} ${path}`);
        if (path === approvalPath) {
          expect(JSON.parse(String(init?.body))).toEqual({ reason: "review" });
          if (scenario === "bad gateway") return new Response(null, { status: 502 });
          if (scenario === "transport error") throw new TypeError("Failed to fetch");
          return Response.json({ run: scenario === "matching approval" ? approved : { ...approved, id: "other" } });
        }
        expect(path).toBe(runPath);
        expect(init?.cache).toBe("no-store");
        return Response.json({ run: approved });
      }) as typeof fetch;
      await expect(approveRun(reviewed, { reason: "review" })).resolves.toEqual(approved);
      expect(calls).toEqual([
        `POST ${approvalPath}`,
        ...(scenario === "matching approval" ? [] : [`GET ${runPath}`]),
      ]);
    },
  );

  test.each([
    { status: "waiting_approval" },
    { id: "other" },
    { capsuleId: "capsule_2" },
    { workspaceId: "workspace_2" },
    { type: "destroy_plan" },
    { planDigest: "sha256:changed" },
    { baseStateGeneration: 2 },
  ] satisfies Partial<Run>[])("an unconfirmed or changed Plan %p leaves the approval unresolved", async (change) => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(`${init?.method} ${path}`);
      if (path === approvalPath) return new Response(null, { status: 502 });
      return Response.json({ run: { ...approved, ...change } });
    }) as typeof fetch;
    await expect(approveRun(reviewed)).rejects.toMatchObject({ status: 502 });
    expect(calls).toEqual([`POST ${approvalPath}`, `GET ${runPath}`]);
  });

  test.each(["refused", "retired"] as const)("the %s approval does not start a readback", async (scenario) => {
    let current = true;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${input}`);
      if (scenario === "retired") current = false;
      return new Response(null, { status: scenario === "refused" ? 403 : 502 });
    }) as typeof fetch;
    await expect(approveRun(reviewed, { isCurrent: () => current }))
      .rejects.toMatchObject(scenario === "refused" ? { status: 403 } : { name: "AbortError" });
    expect(calls).toEqual([`POST ${approvalPath}`]);
  });
});
