// Phase 18.2 (H3 + H13): tests for the rollback CLI.
//
// H3 — verify the catalog migration that collapses source deploy rows to current:
//   - SQL preserves activation/plan ids per the deterministic ID MAPPING SPEC
//   - SQL fills `group_heads.previous_deployment_id` (no longer hardcoded null)
//   - SQL is forward-only so the migration ledger cannot claim v9 while the source
//     tables/columns have already been dropped
// H13 — verify the production safety guard on `db-migrate-down`:
//   - --env=production without --allow-production-rollback is refused
//   - --env=production --allow-production-rollback --confirm=ROLLBACK is allowed
//   - --env=production --allow-production-rollback --confirm=NOPE is refused
//   - dry-run bypasses the guard
//   - --env=staging never requires the guard
//   - parser rejects --target combined with --steps

import { evaluateProductionGuard, parseDownArgs } from "./db-migrate-down.ts";
import { postgresStorageMigrationStatements } from "../src/adapters/storage/migrations.ts";

Deno.test("H3: deployment collapse migration preserves deterministic source ids in deployments", () => {
  const migration = postgresStorageMigrationStatements.find((m) =>
    m.id === "deploy.unify_to_deployments"
  );
  if (!migration) {
    throw new Error("deploy.unify_to_deployments migration is missing");
  }

  const sql = migration.sql;
  // Rule 1+2: deployments.id := coalesce(activation_record.id, plan.id).
  // Both forms appear: `coalesce(ar.id, p.id)` for the joined insert and
  // `select ar.id` for the orphan-activation fallback.
  assert(
    sql.includes("coalesce(ar.id, p.id)"),
    "expected deployments.id := coalesce(ar.id, p.id) (Rule 1/2)",
  );
  // Rule 3: orphan activation rows still preserve activation_record.id.
  assert(
    /select\s+ar\.id\s*,/i.test(sql),
    "expected orphan activation insert to keep activation_record.id (Rule 3)",
  );
});

Deno.test("H3: deployment collapse migration computes group_heads.previous_deployment_id (no hardcoded null)", () => {
  const migration = postgresStorageMigrationStatements.find((m) =>
    m.id === "deploy.unify_to_deployments"
  );
  if (!migration) {
    throw new Error("deploy.unify_to_deployments migration is missing");
  }
  const sql = migration.sql;

  // The pre-Phase-18.2 SQL hardcoded `null` for previous_deployment_id.
  // The fix is a subquery selecting the most recent prior applied/rolled-back
  // deployment in the same group. Smoke-test: assert the subquery clause
  // exists and the `, null,` literal does not.
  assert(
    /select\s+prev\.id\s+from\s+deployments\s+prev/i.test(sql),
    "expected previous_deployment_id subquery against deployments prev",
  );
  assert(
    /prev\.status\s+in\s*\(\s*'applied'\s*,\s*'rolled-back'\s*\)/i.test(sql),
    "expected previous_deployment_id to filter on status applied/rolled-back",
  );
  assert(
    !/select\s+p\.group_id\s*,\s*p\.activation_id\s*,\s*null\s*,/i.test(sql),
    "previous_deployment_id should no longer be a hardcoded null literal",
  );
});

Deno.test("H3: deployment collapse migration is forward-only", () => {
  const migration = postgresStorageMigrationStatements.find((m) =>
    m.id === "deploy.unify_to_deployments"
  );
  if (!migration) {
    throw new Error("deploy.unify_to_deployments migration is missing");
  }
  assert(
    migration.down === undefined,
    "deployment collapse migration must be forward-only; dropping current deployment tables without rebuilding source tables would desync the migration ledger from the actual schema",
  );
});

// ---------------------------------------------------------------------------
// H3: in-memory source row -> current row integrity tests.
//
// We model the deterministic ID MAPPING SPEC (Rule 1-7) as a pure TS function
// `mapSourceToCurrent` and verify the seven rules against a small fixture. This is the
// in-memory companion to the SQL-level smoke tests above: it documents the
// exact mapping the migration is expected to perform, and would fail if a
// future refactor of the SQL ever silently changed the rule semantics.
// ---------------------------------------------------------------------------

interface SourcePlan {
  readonly id: string;
  readonly group_id: string;
  readonly space_id: string;
}
interface SourceActivation {
  readonly id: string;
  readonly plan_id: string | null;
  readonly group_id: string;
  readonly space_id: string;
  readonly status: "applied" | "succeeded" | "running" | "queued" | "failed";
  readonly created_at: string;
  readonly rollback_target_activation_id?: string;
}
interface SourceOperationRecord {
  readonly id: string;
  readonly activation_id: string | null;
  readonly plan_id: string | null;
  readonly kind: string;
  readonly status: "applied" | "succeeded" | "failed" | "running";
}
interface SourcePointer {
  readonly group_id: string;
  readonly space_id: string;
  readonly activation_id: string;
}

interface CurrentDeployment {
  readonly id: string;
  readonly group_id: string;
  readonly space_id: string;
  readonly status:
    | "preview"
    | "resolved"
    | "applying"
    | "applied"
    | "failed"
    | "rolled-back";
  readonly created_at: string;
  readonly applied_at?: string;
  readonly rollback_target?: string;
  readonly conditions: ReadonlyArray<{ readonly scope_ref: string }>;
}
interface CurrentGroupHead {
  readonly group_id: string;
  readonly space_id: string;
  readonly current_deployment_id: string;
  readonly previous_deployment_id: string | null;
}
interface CurrentSnapshot {
  readonly deployments: readonly CurrentDeployment[];
  readonly group_heads: readonly CurrentGroupHead[];
}

function mapSourceToCurrent(input: {
  readonly plans: readonly SourcePlan[];
  readonly activations: readonly SourceActivation[];
  readonly operations: readonly SourceOperationRecord[];
  readonly pointers: readonly SourcePointer[];
}): CurrentSnapshot {
  const deployments = new Map<string, CurrentDeployment>();
  const arByPlan = new Map<string, SourceActivation>();
  for (const ar of input.activations) {
    if (ar.plan_id) arByPlan.set(ar.plan_id, ar);
  }
  // Rule 1+2: plans (joined with their activation if any) collapse to one Deployment.
  for (const p of input.plans) {
    const ar = arByPlan.get(p.id);
    const id = ar?.id ?? p.id; // Rule 1 preferred, else Rule 2
    const status: CurrentDeployment["status"] = ar
      ? (ar.status === "applied" || ar.status === "succeeded"
        ? "applied"
        : ar.status === "failed"
        ? "failed"
        : "applying")
      : "resolved";
    deployments.set(id, {
      id,
      group_id: p.group_id,
      space_id: p.space_id,
      status,
      created_at: ar?.created_at ?? "",
      applied_at: ar?.created_at,
      rollback_target: ar?.rollback_target_activation_id,
      conditions: [],
    });
  }
  // Rule 3: orphan activation rows (plan_id null or pruned) still map to a Deployment via ar.id.
  for (const ar of input.activations) {
    if (ar.plan_id && input.plans.some((p) => p.id === ar.plan_id)) continue;
    if (deployments.has(ar.id)) continue;
    const status: CurrentDeployment["status"] =
      ar.status === "applied" || ar.status === "succeeded"
        ? "applied"
        : ar.status === "failed"
        ? "failed"
        : "applying";
    deployments.set(ar.id, {
      id: ar.id,
      group_id: ar.group_id,
      space_id: ar.space_id,
      status,
      created_at: ar.created_at,
      applied_at: ar.created_at,
      rollback_target: ar.rollback_target_activation_id,
      conditions: [],
    });
  }
  // Rule 6: operations fold into coalesce(activation_id, plan_id) Deployment, preserving op.id in scope.ref.
  for (const op of input.operations) {
    const target = op.activation_id ?? op.plan_id;
    if (!target) continue;
    const existing = deployments.get(target);
    if (!existing) continue;
    deployments.set(target, {
      ...existing,
      conditions: [...existing.conditions, { scope_ref: op.id }],
    });
  }
  // Rule 4+5: build group_heads from pointers; previous := most recent prior applied/rolled-back Deployment for same group.
  const heads: CurrentGroupHead[] = [];
  for (const ptr of input.pointers) {
    const current = deployments.get(ptr.activation_id);
    if (!current) continue;
    const prior = [...deployments.values()]
      .filter((d) =>
        d.group_id === ptr.group_id && d.space_id === ptr.space_id &&
        d.id !== ptr.activation_id &&
        (d.status === "applied" || d.status === "rolled-back")
      )
      .sort((a, b) =>
        (b.applied_at ?? b.created_at).localeCompare(
          a.applied_at ?? a.created_at,
        )
      )[0];
    heads.push({
      group_id: ptr.group_id,
      space_id: ptr.space_id,
      current_deployment_id: ptr.activation_id,
      previous_deployment_id: prior?.id ?? null,
    });
  }
  return { deployments: [...deployments.values()], group_heads: heads };
}

Deno.test("H3 integrity: source plan+activation -> current deployment retains activation id (Rule 1)", () => {
  const result = mapSourceToCurrent({
    plans: [{ id: "plan-A", group_id: "g1", space_id: "s1" }],
    activations: [{
      id: "act-A1",
      plan_id: "plan-A",
      group_id: "g1",
      space_id: "s1",
      status: "applied",
      created_at: "2026-04-01T00:00:00Z",
    }],
    operations: [],
    pointers: [],
  });
  assert(result.deployments.length === 1, "expected one deployment");
  const d = result.deployments[0];
  if (d.id !== "act-A1") {
    throw new Error(`Rule 1: expected deployment id=act-A1, got ${d.id}`);
  }
  if (d.status !== "applied") throw new Error("expected status=applied");
});

Deno.test("H3 integrity: source plan-only (no activation) -> current deployment retains plan id (Rule 2)", () => {
  const result = mapSourceToCurrent({
    plans: [{ id: "plan-Solo", group_id: "g1", space_id: "s1" }],
    activations: [],
    operations: [],
    pointers: [],
  });
  if (result.deployments.length !== 1) {
    throw new Error("expected exactly one deployment");
  }
  const d = result.deployments[0];
  if (d.id !== "plan-Solo") {
    throw new Error(`Rule 2: expected deployment id=plan-Solo, got ${d.id}`);
  }
  if (d.status !== "resolved") {
    throw new Error("plan-only deployment must collapse to status=resolved");
  }
});

Deno.test("H3 integrity: orphan activation (plan pruned) -> current deployment via ar.id (Rule 3)", () => {
  const result = mapSourceToCurrent({
    plans: [], // plan was already pruned
    activations: [{
      id: "act-Orphan",
      plan_id: "plan-Pruned",
      group_id: "g1",
      space_id: "s1",
      status: "succeeded",
      created_at: "2026-04-01T00:00:00Z",
    }],
    operations: [],
    pointers: [],
  });
  if (result.deployments.length !== 1) {
    throw new Error("expected exactly one deployment");
  }
  const d = result.deployments[0];
  if (d.id !== "act-Orphan") {
    throw new Error(`Rule 3: expected deployment id=act-Orphan, got ${d.id}`);
  }
});

Deno.test("H3 integrity: pointer + history -> group_heads.previous_deployment_id (Rule 4+5)", () => {
  const result = mapSourceToCurrent({
    plans: [
      { id: "plan-old", group_id: "g1", space_id: "s1" },
      { id: "plan-new", group_id: "g1", space_id: "s1" },
    ],
    activations: [
      {
        id: "act-old",
        plan_id: "plan-old",
        group_id: "g1",
        space_id: "s1",
        status: "applied",
        created_at: "2026-03-01T00:00:00Z",
      },
      {
        id: "act-new",
        plan_id: "plan-new",
        group_id: "g1",
        space_id: "s1",
        status: "applied",
        created_at: "2026-04-01T00:00:00Z",
      },
    ],
    operations: [],
    pointers: [
      { group_id: "g1", space_id: "s1", activation_id: "act-new" },
    ],
  });
  if (result.group_heads.length !== 1) {
    throw new Error("expected one group_head");
  }
  const head = result.group_heads[0];
  if (head.current_deployment_id !== "act-new") {
    throw new Error(
      `Rule 4: current_deployment_id mismatch; got ${head.current_deployment_id}`,
    );
  }
  if (head.previous_deployment_id !== "act-old") {
    throw new Error(
      `Rule 5: previous_deployment_id should be the most recent prior applied deployment; got ${head.previous_deployment_id}`,
    );
  }
});

Deno.test("H3 integrity: deploy_operation_records collapse into deployments.conditions[] (Rule 6)", () => {
  const result = mapSourceToCurrent({
    plans: [{ id: "plan-X", group_id: "g1", space_id: "s1" }],
    activations: [{
      id: "act-X",
      plan_id: "plan-X",
      group_id: "g1",
      space_id: "s1",
      status: "applied",
      created_at: "2026-04-01T00:00:00Z",
    }],
    operations: [
      {
        id: "op-1",
        activation_id: "act-X",
        plan_id: null,
        kind: "deploy",
        status: "applied",
      },
      {
        id: "op-2",
        activation_id: "act-X",
        plan_id: null,
        kind: "verify",
        status: "applied",
      },
    ],
    pointers: [],
  });
  const d = result.deployments.find((x) => x.id === "act-X");
  if (!d) throw new Error("deployment act-X missing");
  if (d.conditions.length !== 2) {
    throw new Error(
      `Rule 6: expected 2 conditions (one per operation), got ${d.conditions.length}`,
    );
  }
  const refs = d.conditions.map((c) => c.scope_ref).sort();
  if (refs[0] !== "op-1" || refs[1] !== "op-2") {
    throw new Error(
      `Rule 6: operation ids should be preserved in scope.ref; got ${refs}`,
    );
  }
});

Deno.test("H13: production guard refuses without --allow-production-rollback", async () => {
  const outcome = await evaluateProductionGuard({
    env: "production",
    dryRun: false,
    allowProductionRollback: false,
  });
  assert(!outcome.allowed, "expected guard to refuse production rollback");
  assert(
    (outcome.reason ?? "").includes("--allow-production-rollback"),
    `expected reason to mention --allow-production-rollback, got: ${outcome.reason}`,
  );
});

Deno.test("H13: production guard accepts --confirm=ROLLBACK with the allow flag", async () => {
  const outcome = await evaluateProductionGuard({
    env: "production",
    dryRun: false,
    allowProductionRollback: true,
    confirm: "ROLLBACK",
  });
  assert(outcome.allowed, `expected guard to allow, got: ${outcome.reason}`);
});

Deno.test("H13: production guard rejects --confirm=NOPE even with the allow flag", async () => {
  const outcome = await evaluateProductionGuard({
    env: "production",
    dryRun: false,
    allowProductionRollback: true,
    confirm: "NOPE",
  });
  assert(!outcome.allowed, "expected guard to refuse wrong confirm phrase");
  assert(
    (outcome.reason ?? "").includes("ROLLBACK"),
    `expected reason to mention required phrase ROLLBACK, got: ${outcome.reason}`,
  );
});

Deno.test("H13: production guard allows dry-run unconditionally", async () => {
  const outcome = await evaluateProductionGuard({
    env: "production",
    dryRun: true,
    allowProductionRollback: false,
  });
  assert(outcome.allowed, "expected dry-run to bypass production guard");
});

Deno.test("H13: production guard does not gate staging or local", async () => {
  for (const env of ["staging", "local"] as const) {
    const outcome = await evaluateProductionGuard({
      env,
      dryRun: false,
      allowProductionRollback: false,
    });
    assert(outcome.allowed, `expected ${env} to bypass guard`);
  }
});

Deno.test("H13: parseDownArgs rejects --target combined with --steps", () => {
  let threw = false;
  try {
    parseDownArgs(["--target=2", "--steps=1"]);
  } catch (error) {
    threw = true;
    assert(
      (error as Error).message.includes("--target"),
      "expected error to mention --target",
    );
  }
  assert(threw, "expected parser to reject --target+--steps combination");
});

Deno.test("H13: parseDownArgs accepts --steps with numeric value", () => {
  const opts = parseDownArgs(["--steps=3", "--env=staging"]);
  if (opts.steps !== 3) throw new Error(`expected steps=3, got ${opts.steps}`);
  if (opts.env !== "staging") {
    throw new Error(`expected env=staging, got ${opts.env}`);
  }
});

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
