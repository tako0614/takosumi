import { afterEach, expect, test } from "bun:test";
import { advanceGitRevisionPlan } from "../../../../dashboard/src/lib/control-api.ts";
import { createReAdoptionPlanSubmission } from "../../../../dashboard/src/lib/re-adoption-plan.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const selection = () => ({
  capsuleId: "capsule_a", sourceId: "source_a", targetRef: "release/v2",
  request: { sourceSnapshotId: "snapshot_two", reason: "Review target inputs",
    reviewedUserVariables: { release_note: "fixture-note", optional_flag: false },
    expected: { authorityGuard: "fixture-current-guard" } },
});
const receipt = () => ({
  capsule: { id: "capsule_a", installConfigId: "config_target", currentStateGeneration: 4, currentStateVersionId: "state_four" },
  installConfigReAdoption: { replayed: false, targetInstallConfigId: "config_target", sourceSnapshotId: "snapshot_two" },
});
const planned = () => ({
  revisionPlan: { id: "revision_two", capsuleId: "capsule_a", sourceId: "source_a", planRunId: "plan_two", sourceSnapshotId: "snapshot_two",
    revision: { targetRef: "release/v2", base: { installConfigId: "config_target", capsuleStateGeneration: 4, capsuleStateVersionId: "state_four" } } },
  nextAction: "review_run", links: { self: "/api/v1/revision-plans/revision_two" },
});

test("explicit re-adoption recovery freezes the answer and keeps separate mutation and Plan keys", async () => {
  const calls: Array<{ path: string; key: string | null; body: unknown }> = [];
  let adopts = 0, plans = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
    if (path.endsWith("/install-config-re-adoptions")) {
      if (++adopts === 1) throw new Error("fixture lost adoption ACK");
      return json(receipt());
    }
    if (path.endsWith("/revision-plans")) {
      if (++plans === 1) throw new Error("fixture lost Plan ACK");
      return json(planned());
    }
    throw new Error("unexpected fixture request");
  }) as typeof fetch;
  const input = selection();
  const expected = structuredClone(input.request);
  const operation = createReAdoptionPlanSubmission(input, () => true);
  input.request.reviewedUserVariables.release_note = "later-edit";
  input.request.expected.authorityGuard = "later-guard";
  input.targetRef = "later-ref";
  const first = operation.submit();
  expect(operation.submit()).toBe(first);
  await expect(first).rejects.toThrow("fixture lost adoption ACK");
  expect([adopts, plans]).toEqual([1, 0]);
  await expect(operation.submit()).rejects.toThrow("fixture lost Plan ACK");
  expect(operation.adoptionAcknowledged()).toBe(true);
  expect([adopts, plans]).toEqual([2, 1]);
  expect(await operation.submit()).toBe("plan_two");
  expect(await operation.submit()).toBe("plan_two");
  expect([adopts, plans]).toEqual([2, 2]);
  expect(calls.slice(0, 2).map(call => call.body)).toEqual([expected, expected]);
  expect(calls[0]!.key).toBe(calls[1]!.key);
  expect(calls[2]!.key).toBe(calls[3]!.key);
  expect(calls[0]!.key).not.toBe(calls[2]!.key);
  expect(calls.slice(2).map(call => call.body)).toEqual([{ ref: "release/v2" }, { ref: "release/v2" }]);
  expect(calls.some(call => /\/(apply|approve)$/.test(call.path))).toBe(false);
});

test("a changed person or selection after adoption cannot dispatch its Plan", async () => {
  let current = true, calls = 0;
  globalThis.fetch = (async () => { calls += 1; current = false; return json(receipt()); }) as typeof fetch;
  const operation = createReAdoptionPlanSubmission(selection(), () => current);
  await expect(operation.submit()).rejects.toMatchObject({ code: "re_adoption_context_changed" });
  expect(operation.adoptionAcknowledged()).toBe(true);
  await expect(operation.submit()).rejects.toMatchObject({ code: "re_adoption_context_changed" });
  expect(calls).toBe(1);
});

test("retiring target inputs retains the accepted adoption and stops its revision loop", async () => {
  let current = true;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    if (path.endsWith("/install-config-re-adoptions")) return json(receipt());
    if (path.endsWith("/revision-plans")) {
      current = false;
      return json({ ...planned(), nextAction: "reconcile" });
    }
    return json(planned());
  }) as typeof fetch;

  const operation = createReAdoptionPlanSubmission(selection(), () => current);
  const failure = await operation.submit().catch((cause: unknown) => cause);
  expect(requests).toEqual([
    "/api/v1/capsules/capsule_a/install-config-re-adoptions",
    "/api/v1/capsules/capsule_a/revision-plans",
  ]);
  expect(failure).toMatchObject({ name: "AbortError" });
  expect(operation.adoptionAcknowledged()).toBe(true);
  expect(operation.completedPlanId()).toBeUndefined();

  current = true;
  await expect(advanceGitRevisionPlan("revision_two", { isCurrent: () => current }))
    .resolves.toMatchObject({ nextAction: "review_run", revisionPlan: { planRunId: "plan_two" } });
  expect(requests.slice(2)).toEqual(["/api/v1/revision-plans/revision_two/reconcile"]);
});

test("target snapshot ref app configuration and state must match before Plan review", async () => {
  for (const mismatch of ["snapshot", "ref", "app", "source", "config", "generation", "state"] as const) {
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 1) return json(receipt());
      const result = planned();
      if (mismatch === "snapshot") result.revisionPlan.sourceSnapshotId = "snapshot_other";
      if (mismatch === "ref") result.revisionPlan.revision.targetRef = "ref_other";
      if (mismatch === "app") result.revisionPlan.capsuleId = "capsule_other";
      if (mismatch === "source") result.revisionPlan.sourceId = "source_other";
      if (mismatch === "config") result.revisionPlan.revision.base.installConfigId = "config_other";
      if (mismatch === "generation") result.revisionPlan.revision.base.capsuleStateGeneration = 5;
      if (mismatch === "state") result.revisionPlan.revision.base.capsuleStateVersionId = "state_other";
      return json(result);
    }) as typeof fetch;
    await expect(createReAdoptionPlanSubmission(selection(), () => true).submit()).rejects.toMatchObject({ code: "re_adoption_target_changed" });
    expect(calls).toBe(2);
  }
});

test("an unconfirmed adoption receipt never becomes a Plan request", async () => {
  for (const mismatch of ["app", "snapshot", "config", "generation"] as const) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const result = receipt();
      if (mismatch === "app") result.capsule.id = "capsule_other";
      if (mismatch === "snapshot") result.installConfigReAdoption.sourceSnapshotId = "snapshot_other";
      if (mismatch === "config") result.capsule.installConfigId = "config_other";
      if (mismatch === "generation") result.capsule.currentStateGeneration = -1;
      return json(result);
    }) as typeof fetch;
    await expect(createReAdoptionPlanSubmission(selection(), () => true).submit()).rejects.toMatchObject({ code: "invalid_re_adoption_response" });
    expect(calls).toBe(1);
  }
});
