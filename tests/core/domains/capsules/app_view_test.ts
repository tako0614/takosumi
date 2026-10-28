import { expect, test } from "bun:test";
import {
  CAPSULE_APP_ACTIONS,
  CAPSULE_APP_PROBLEM_CODES,
  CAPSULE_APP_STATES,
} from "takosumi-contract/capsules";
import {
  CAPSULE_APP_INSTALL_STALL_AFTER_MS,
  deriveCapsuleAppStatus,
  type CapsuleAppFacts,
  type CapsuleAppLatestRun,
} from "../../../../core/domains/capsules/app_view.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const RECENT = new Date(NOW - 60_000).toISOString();
const OLD = new Date(NOW - CAPSULE_APP_INSTALL_STALL_AFTER_MS - 1).toISOString();

type CapsuleFacts = CapsuleAppFacts["capsule"];

const APPLIED: CapsuleFacts = {
  status: "active",
  currentStateVersionId: "sv_1",
  currentStateGeneration: 1,
  updatedAt: RECENT,
};
const UNAPPLIED: CapsuleFacts = {
  status: "pending",
  currentStateGeneration: 0,
  updatedAt: RECENT,
};

function run(over: Partial<CapsuleAppLatestRun>): CapsuleAppLatestRun {
  return {
    id: "run_1",
    type: "apply",
    status: "succeeded",
    createdAt: RECENT,
    ...over,
  };
}

function facts(over: Partial<CapsuleAppFacts>): CapsuleAppFacts {
  return {
    capsule: APPLIED,
    revisionPreparing: false,
    connectionIssues: [],
    screenCount: 0,
    now: NOW,
    ...over,
  };
}

const uninstall = (
  phase: "scheduled" | "destroying" | "cancelled",
  over: Record<string, unknown> = {},
) => ({
  id: "uninst_1",
  revision: 1,
  phase,
  requestedAt: RECENT,
  scheduledDestroyAt: "2026-11-03T12:00:00.000Z",
  previousStatus: "active" as const,
  ...over,
});

interface Row {
  readonly name: string;
  readonly facts: CapsuleAppFacts;
  readonly state: (typeof CAPSULE_APP_STATES)[number];
  readonly action: (typeof CAPSULE_APP_ACTIONS)[number];
  readonly problems: readonly (typeof CAPSULE_APP_PROBLEM_CODES)[number][];
}

const ROWS: readonly Row[] = [
  // installing
  {
    name: "a first plan running",
    facts: facts({ capsule: UNAPPLIED, latestRun: run({ type: "plan", status: "running" }) }),
    state: "installing",
    action: "none",
    problems: [],
  },
  {
    name: "a first plan waiting for review",
    facts: facts({ capsule: UNAPPLIED, latestRun: run({ type: "plan", status: "succeeded" }) }),
    state: "installing",
    action: "review",
    problems: [],
  },
  {
    name: "a fresh Capsule before its first plan",
    facts: facts({ capsule: UNAPPLIED }),
    state: "installing",
    action: "none",
    problems: [],
  },
  // installed
  {
    name: "applied with screens",
    facts: facts({ latestRun: run({}), screenCount: 2 }),
    state: "installed",
    action: "open",
    problems: [],
  },
  {
    name: "applied without screens",
    facts: facts({ latestRun: run({}) }),
    state: "installed",
    action: "view_resources",
    problems: [],
  },
  {
    name: "an applied app whose later plan was left unreviewed stays installed",
    facts: facts({ latestRun: run({ type: "plan", status: "succeeded" }), screenCount: 1 }),
    state: "installed",
    action: "open",
    problems: [],
  },
  {
    name: "a stale app is still installed (update is a version fact)",
    facts: facts({ capsule: { ...APPLIED, status: "stale" }, screenCount: 1 }),
    state: "installed",
    action: "open",
    problems: [],
  },
  // updating
  {
    name: "an update plan running",
    facts: facts({ latestRun: run({ type: "plan", status: "queued" }) }),
    state: "updating",
    action: "none",
    problems: [],
  },
  {
    name: "the revision coordinator preparing",
    facts: facts({ revisionPreparing: true, latestRun: run({}) }),
    state: "updating",
    action: "none",
    problems: [],
  },
  {
    name: "a retry in flight hides the old failure but keeps a broken connection listed",
    facts: facts({
      latestRun: run({ status: "running" }),
      connectionIssues: [{ provider: "registry.opentofu.org/hashicorp/aws", status: "revoked" }],
    }),
    state: "updating",
    action: "none",
    problems: ["connection_unavailable"],
  },
  // needs_attention
  {
    name: "a failed apply",
    facts: facts({ latestRun: run({ status: "failed", errorCode: "apply_failed" }) }),
    state: "needs_attention",
    action: "retry",
    problems: ["run_failed"],
  },
  {
    name: "a first install whose plan failed",
    facts: facts({ capsule: UNAPPLIED, latestRun: run({ type: "plan", status: "failed" }) }),
    state: "needs_attention",
    action: "retry",
    problems: ["run_failed"],
  },
  {
    name: "a policy-denied plan",
    facts: facts({
      latestRun: run({ type: "plan", status: "failed", policyStatus: "deny", errorCode: "policy_denied" }),
    }),
    state: "needs_attention",
    action: "review",
    problems: ["policy_blocked"],
  },
  {
    name: "a revoked connection outranks a failed run",
    facts: facts({
      latestRun: run({ status: "failed" }),
      connectionIssues: [
        { provider: "registry.opentofu.org/hashicorp/aws", connectionId: "conn_1", status: "revoked" },
      ],
    }),
    state: "needs_attention",
    action: "fix_connection",
    problems: ["connection_unavailable", "run_failed"],
  },
  {
    name: "Capsule error without a failed run",
    facts: facts({ capsule: { ...APPLIED, status: "error" }, latestRun: run({}) }),
    state: "needs_attention",
    action: "retry",
    problems: ["capsule_error"],
  },
  {
    name: "a dead-lettered screen",
    facts: facts({
      latestRun: run({}),
      screenFailure: {
        id: "intent_1",
        failureDigest: `sha256:${"a".repeat(64)}`,
        stateVersionId: "sv_1",
        stateGeneration: 1,
        errorCode: "interface_owner_missing",
      },
    }),
    state: "needs_attention",
    action: "retry_screen",
    problems: ["screen_unavailable"],
  },
  {
    name: "a never-applied app with no recent progress",
    facts: facts({ capsule: { ...UNAPPLIED, updatedAt: OLD } }),
    state: "needs_attention",
    action: "continue_install",
    problems: ["install_incomplete"],
  },
  {
    name: "a cancelled first plan long ago",
    facts: facts({
      capsule: { ...UNAPPLIED, updatedAt: OLD },
      latestRun: run({ type: "plan", status: "cancelled" }),
    }),
    state: "needs_attention",
    action: "continue_install",
    problems: ["install_incomplete"],
  },
  // stopped
  {
    name: "operator-disabled",
    facts: facts({ capsule: { ...APPLIED, status: "disabled" } }),
    state: "stopped",
    action: "none",
    problems: [],
  },
  // uninstall
  {
    name: "inside the grace period",
    facts: facts({ capsule: { ...APPLIED, status: "uninstalled", uninstall: uninstall("scheduled") } }),
    state: "uninstall_scheduled",
    action: "cancel_uninstall",
    problems: ["uninstall_scheduled"],
  },
  {
    name: "teardown running",
    facts: facts({ capsule: { ...APPLIED, status: "uninstalled", uninstall: uninstall("destroying") } }),
    state: "uninstalling",
    action: "none",
    problems: [],
  },
  {
    name: "teardown blocked before dispatch",
    facts: facts({
      capsule: {
        ...APPLIED,
        status: "uninstalled",
        uninstall: uninstall("destroying", { blockedReason: "teardown_plan_not_delete_only" }),
      },
    }),
    state: "needs_attention",
    action: "cancel_uninstall",
    problems: ["uninstall_blocked"],
  },
  {
    name: "teardown failed",
    facts: facts({
      capsule: { ...APPLIED, status: "error", uninstall: uninstall("destroying") },
      latestRun: run({ type: "destroy_apply", status: "failed", errorCode: "apply_failed" }),
    }),
    state: "needs_attention",
    action: "retry",
    problems: ["uninstall_failed"],
  },
  {
    name: "an immediate destroy apply running",
    facts: facts({ latestRun: run({ type: "destroy_apply", status: "running" }) }),
    state: "uninstalling",
    action: "none",
    problems: [],
  },
  {
    name: "destroyed",
    facts: facts({ capsule: { ...APPLIED, status: "destroyed" } }),
    state: "uninstalled",
    action: "reinstall",
    problems: [],
  },
];

for (const row of ROWS) {
  test(`app state: ${row.name}`, () => {
    const derived = deriveCapsuleAppStatus(row.facts);
    expect(derived.state).toBe(row.state);
    expect(derived.primaryAction).toBe(row.action);
    expect(derived.problems.map((problem) => problem.code)).toEqual([...row.problems]);
  });
}

test("every state and every primary action is reachable from the table", () => {
  expect(new Set(ROWS.map((row) => row.state))).toEqual(new Set(CAPSULE_APP_STATES));
  expect(new Set(ROWS.map((row) => row.action))).toEqual(new Set(CAPSULE_APP_ACTIONS));
  expect(new Set(ROWS.flatMap((row) => row.problems))).toEqual(
    new Set(CAPSULE_APP_PROBLEM_CODES),
  );
});

test("problems carry the exact Run, connection and screen failure they are about", () => {
  const failed = deriveCapsuleAppStatus(facts({
    latestRun: run({ id: "run_failed_1", type: "apply", status: "failed", errorCode: "credential_mint_failed" }),
    connectionIssues: [
      { provider: "registry.opentofu.org/cloudflare/cloudflare", connectionId: "conn_cf", status: "missing" },
    ],
  }));
  expect(failed.problems).toEqual([
    {
      code: "connection_unavailable",
      severity: "error",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      connectionId: "conn_cf",
      connectionStatus: "missing",
    },
    {
      code: "run_failed",
      severity: "error",
      runId: "run_failed_1",
      runType: "apply",
      errorCode: "credential_mint_failed",
    },
  ]);
  const teardown = deriveCapsuleAppStatus(facts({
    capsule: { ...APPLIED, status: "error", uninstall: uninstall("destroying") },
    latestRun: run({ id: "run_destroy", type: "destroy_apply", status: "failed" }),
  }));
  expect(teardown.problems[0]).toEqual({
    code: "uninstall_failed",
    severity: "error",
    runId: "run_destroy",
    runType: "destroy_apply",
  });
});
