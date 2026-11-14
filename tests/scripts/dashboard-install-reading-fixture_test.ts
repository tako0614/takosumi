import { expect, test } from "bun:test";
import { createInstallAttemptFixture, type InstallAttemptFixture } from "../dashboard/e2e/fixture-data.ts";

type Projection = {
  installPlan: {
    id: string; phase: string; generation: number; source: unknown;
    capsuleId?: string; planRunId?: string; diagnostic?: { code: string };
  };
};

function create(fixture: InstallAttemptFixture): Projection {
  const result = fixture.handle({
    method: "POST", path: "/api/v1/install-plans", idempotencyKey: "reading-fixture-once",
    body: { mode: "attempt", source: { url: "https://git.example.test/app.git" } },
  });
  expect(result?.status).toBe(201);
  return result!.json as Projection;
}

function reconcile(fixture: InstallAttemptFixture, id: string): Projection {
  const result = fixture.handle({ method: "POST", path: `/api/v1/install-plans/${id}/reconcile` });
  expect(result?.status).toBe(200);
  return result!.json as Projection;
}

test("reading fixture holds without consuming rounds, then uses normal reconcile transitions", () => {
  let held = true;
  const fixture = createInstallAttemptFixture({ roundsPerPhase: 2, holdSourceReading: () => held });
  const initial = create(fixture).installPlan;
  for (let count = 0; count < 8; count++) {
    expect(reconcile(fixture, initial.id).installPlan).toEqual(initial);
  }
  expect(fixture.log.reconciles).toBe(8);
  expect(fixture.log.creates).toHaveLength(1);
  expect(fixture.log.answers).toEqual([]);
  held = false;
  expect(reconcile(fixture, initial.id).installPlan.phase).toBe("syncing_source");
  expect(reconcile(fixture, initial.id).installPlan.phase).toBe("analyzing_compatibility");
  expect(reconcile(fixture, initial.id).installPlan.phase).toBe("analyzing_compatibility");
  const awaiting = reconcile(fixture, initial.id).installPlan;
  expect(awaiting).toMatchObject({ id: initial.id, generation: 2, phase: "awaiting_input", source: initial.source });
  expect(awaiting.capsuleId).toBeUndefined();
  expect(awaiting.planRunId).toBeUndefined();
  expect(fixture.log.answers).toEqual([]);
});

test("reading fixture preserves default and configured rounds for other callers", () => {
  for (const rounds of [1, 6]) {
    const fixture = rounds === 1 ? createInstallAttemptFixture() : createInstallAttemptFixture({ roundsPerPhase: rounds });
    const initial = create(fixture).installPlan;
    for (let count = 1; count <= rounds * 2; count++) {
      const plan = reconcile(fixture, initial.id).installPlan;
      expect(plan.phase).toBe(count < rounds ? "syncing_source" : count < rounds * 2 ? "analyzing_compatibility" : "awaiting_input");
      expect(plan.generation).toBe(count < rounds ? 0 : count < rounds * 2 ? 1 : 2);
      expect(plan.planRunId).toBeUndefined();
    }
    expect(fixture.log.creates).toHaveLength(1);
    expect(fixture.log.answers).toEqual([]);
  }
});

test("reading fixture hold does not mask a later phase failure", () => {
  let held = false;
  const fixture = createInstallAttemptFixture({
    holdSourceReading: () => held,
    failAt: { phase: "awaiting_input", code: "fixture_expected_failure" },
  });
  const initial = create(fixture).installPlan;
  expect(reconcile(fixture, initial.id).installPlan.phase).toBe("analyzing_compatibility");
  held = true;
  const failed = reconcile(fixture, initial.id).installPlan;
  expect(failed).toMatchObject({ id: initial.id, generation: 2, phase: "failed", diagnostic: { code: "fixture_expected_failure" } });
  expect(failed.capsuleId).toBeUndefined();
  expect(failed.planRunId).toBeUndefined();
});
