import { expect, test } from "bun:test";
import type { CapsuleAppLink, CapsuleUninstall } from "takosumi-contract/capsules";
import {
  CAPSULE_APP_ACTIONS,
  CAPSULE_APP_PROBLEM_CODES,
  CAPSULE_APP_STATES,
} from "takosumi-contract/capsules";
import {
  CAPSULE_APP_INSTALL_STALL_AFTER_MS,
  deriveCapsuleAppStatus,
  liveCapsuleUninstall,
  type CapsuleAppFacts,
  type CapsuleAppLatestRun,
} from "../../../../core/domains/capsules/app_view.ts";
import {
  advancedUninstallRecord,
  scheduledUninstallRecord,
  uninstallGraceMs,
} from "../../../../core/domains/capsules/uninstall.ts";
import { SCHEDULED_DESTROY_BLOCKED_REASONS } from "../../../../core/domains/capsules/uninstall_finalize.ts";
import { UNINSTALL_AUTHORIZATION_REASONS } from "../../../../core/domains/capsules/uninstall_authorization.ts";

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

const LINK: CapsuleAppLink = {
  linkId: "ifl_app",
  requirementKey: "data",
  consumerCapsuleId: "cap_consumer",
  providerCapsuleId: "cap_provider",
  providerInterfaceId: "if_data",
  interfaceType: "data",
  interfaceVersion: "1",
  permissions: ["data.read"],
  state: "active",
  generation: 1,
  health: "ok",
  canManage: true,
  candidateCount: 1,
};

/** An incoming link (`usedBy`) the caller may approve on this provider app. */
const REQUEST: CapsuleAppLink = {
  ...LINK,
  linkId: "ifl_request",
  consumerCapsuleId: "cap_requester",
  providerCapsuleId: "cap_app",
  state: "pending_approval",
  canApprove: true,
};

/** A record exactly as the schedule command writes it. */
const SCHEDULED: CapsuleUninstall = scheduledUninstallRecord({
  id: "uninstall_1",
  previous: undefined,
  previousStatus: "active",
  now: new Date(NOW - 8 * 24 * 60 * 60 * 1000),
  graceMs: uninstallGraceMs(7),
  requester: { subject: "user_test" },
});
/** The finalizer's own transitions on that record. */
const advance = (
  record: CapsuleUninstall,
  changes: Parameters<typeof advancedUninstallRecord>[1],
) => advancedUninstallRecord(record, changes);
const WITH_PLAN = advance(advance(SCHEDULED, {
  preDestroyExportStartedAt: RECENT,
}), {
  preDestroyExport: { status: "skipped", reason: "backups_unavailable", at: RECENT },
  destroyPlanRunId: "plan_finalizer",
  destroyPlanRequestedAt: RECENT,
  destroyAttempts: 1,
});
const DESTROYING = advance(WITH_PLAN, { phase: "destroying", destroyStartedAt: RECENT });

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
    uninstallCancellable: false,
    now: NOW,
    ...over,
  };
}

const uninstalled = (record: CapsuleUninstall): CapsuleFacts => ({
  ...APPLIED,
  status: "uninstalled",
  uninstall: record,
});
/** The row after a teardown that reached the provider failed (run engine). */
const TEARDOWN_FAILED: CapsuleFacts = {
  ...APPLIED,
  status: "error",
  uninstall: DESTROYING,
};

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
  {
    name: "a never-applied app being prepared stays installing past the stall threshold",
    facts: facts({ capsule: { ...UNAPPLIED, updatedAt: OLD }, revisionPreparing: true }),
    state: "installing",
    action: "none",
    problems: [],
  },
  {
    name: "a failed first plan being prepared again does not offer a racing retry",
    facts: facts({
      capsule: UNAPPLIED,
      revisionPreparing: true,
      latestRun: run({ type: "plan", status: "failed", errorCode: "plan_failed" }),
    }),
    state: "installing",
    action: "none",
    problems: ["run_failed"],
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
    name: "an unread screen list does not downgrade Open",
    facts: facts({ latestRun: run({}), screenCount: undefined }),
    state: "installed",
    action: "open",
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
  {
    name: "an old uninstall record no longer counts after the status was restored",
    facts: facts({
      capsule: { ...APPLIED, status: "active", uninstall: DESTROYING },
      latestRun: run({ type: "apply", status: "succeeded" }),
      screenCount: 1,
    }),
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
    name: "a removed Interface link provider needs a new selection",
    facts: facts({ interfaceLinks: [{ ...LINK, health: "provider_removed" }] }),
    state: "needs_attention",
    action: "fix_interface_link",
    problems: ["interface_link_unavailable"],
  },
  {
    name: "a not-ready Interface link provider warns without blocking the app",
    facts: facts({ interfaceLinks: [{ ...LINK, health: "provider_not_ready" }] }),
    state: "installed",
    action: "view_resources",
    problems: ["interface_link_unavailable"],
  },
  {
    name: "a scheduled provider uninstall warns while the app keeps opening",
    facts: facts({ interfaceLinks: [{ ...LINK, health: "provider_uninstall_scheduled" }], screenCount: 1 }),
    state: "installed",
    action: "open",
    problems: ["interface_link_degraded"],
  },
  {
    name: "an unset requirement warns without stopping the app",
    facts: facts({ interfaceLinks: [{ ...LINK, state: "unset", health: "provider_not_ready", generation: 0 }], screenCount: 1 }),
    state: "installed",
    action: "open",
    problems: ["interface_link_unset"],
  },
  {
    name: "a link request waiting for this provider's approval informs without replacing Open",
    facts: facts({ interfaceLinkRequests: [REQUEST], screenCount: 1 }),
    state: "installed",
    action: "open",
    problems: ["interface_link_approval_pending"],
  },
  {
    name: "an Interface repair in progress does not offer a racing action",
    facts: facts({ interfaceLinks: [{ ...LINK, health: "provider_removed" }], revisionPreparing: true }),
    state: "updating",
    action: "none",
    problems: ["interface_link_unavailable"],
  },
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
  {
    name: "operator-disabled with an old teardown record is still stopped",
    facts: facts({
      capsule: { ...APPLIED, status: "disabled", uninstall: DESTROYING },
      latestRun: run({ type: "destroy_apply", status: "failed" }),
    }),
    state: "stopped",
    action: "none",
    problems: [],
  },
  // two-stage uninstall: grace period
  {
    name: "inside the grace period",
    facts: facts({ capsule: uninstalled(SCHEDULED), uninstallCancellable: true }),
    state: "uninstall_scheduled",
    action: "cancel_uninstall",
    problems: ["uninstall_scheduled"],
  },
  {
    name: "the finalizer's teardown plan is waiting for the finalizer, not the person",
    facts: facts({
      capsule: uninstalled(WITH_PLAN),
      latestRun: run({ id: "plan_finalizer", type: "destroy_plan", status: "waiting_approval" }),
      uninstallCancellable: true,
    }),
    state: "uninstalling",
    action: "none",
    problems: [],
  },
  // two-stage uninstall: the finalizer stopped while still `scheduled`
  ...[
    SCHEDULED_DESTROY_BLOCKED_REASONS.exportIncomplete,
    SCHEDULED_DESTROY_BLOCKED_REASONS.planCancelled,
    SCHEDULED_DESTROY_BLOCKED_REASONS.planNotDeleteOnly,
    SCHEDULED_DESTROY_BLOCKED_REASONS.finalizeFailed,
    UNINSTALL_AUTHORIZATION_REASONS.denied,
  ].map((blockedReason): Row => ({
    name: `a scheduled uninstall blocked by ${blockedReason}`,
    facts: facts({
      capsule: uninstalled(advance(WITH_PLAN, { blockedReason })),
      latestRun: run({ id: "plan_finalizer", type: "destroy_plan", status: "waiting_approval" }),
      uninstallCancellable: true,
    }),
    state: "needs_attention",
    action: "cancel_uninstall",
    problems: ["uninstall_blocked"],
  })),
  // two-stage uninstall: teardown
  {
    name: "teardown running",
    facts: facts({
      capsule: uninstalled(DESTROYING),
      latestRun: run({ type: "destroy_apply", status: "running" }),
    }),
    state: "uninstalling",
    action: "none",
    problems: [],
  },
  {
    name: "teardown approved, apply not yet created",
    facts: facts({ capsule: uninstalled(DESTROYING) }),
    state: "uninstalling",
    action: "none",
    problems: [],
  },
  {
    name: "teardown blocked before dispatch can still be cancelled",
    facts: facts({
      capsule: uninstalled(advance(DESTROYING, { blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.applyRefused })),
      uninstallCancellable: true,
    }),
    state: "needs_attention",
    action: "cancel_uninstall",
    problems: ["uninstall_blocked"],
  },
  {
    name: "teardown blocked after the runtime became unsafe can only be uninstalled now",
    facts: facts({
      capsule: uninstalled(advance(DESTROYING, { blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.applyRefused })),
      latestRun: run({ type: "apply", status: "failed", errorCode: "provider_apply_failed" }),
      uninstallCancellable: false,
    }),
    state: "needs_attention",
    action: "uninstall_now",
    problems: ["uninstall_blocked"],
  },
  {
    name: "the person's own teardown plan during a blocked uninstall waits for their review",
    facts: facts({
      capsule: uninstalled(advance(WITH_PLAN, { blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.planNotDeleteOnly })),
      latestRun: run({ id: "plan_now", type: "destroy_plan", status: "waiting_approval" }),
      uninstallCancellable: true,
    }),
    state: "uninstalling",
    action: "review",
    problems: [],
  },
  // a teardown that reached the provider failed (`error` + `destroying`)
  {
    name: "teardown failed",
    facts: facts({
      capsule: TEARDOWN_FAILED,
      latestRun: run({ type: "destroy_apply", status: "failed", errorCode: "provider_destroy_failed" }),
    }),
    state: "needs_attention",
    action: "retry",
    problems: ["uninstall_failed"],
  },
  {
    name: "a retried teardown apply is running",
    facts: facts({
      capsule: TEARDOWN_FAILED,
      latestRun: run({ type: "destroy_apply", status: "running" }),
    }),
    state: "uninstalling",
    action: "none",
    problems: [],
  },
  {
    name: "a retried teardown plan waits for approval",
    facts: facts({
      capsule: TEARDOWN_FAILED,
      latestRun: run({ type: "destroy_plan", status: "waiting_approval" }),
    }),
    state: "uninstalling",
    action: "review",
    problems: [],
  },
  {
    name: "a later ordinary plan failure is a run failure, not an uninstall failure",
    facts: facts({
      capsule: TEARDOWN_FAILED,
      latestRun: run({ type: "plan", status: "failed", errorCode: "plan_failed" }),
    }),
    state: "needs_attention",
    action: "retry",
    problems: ["run_failed"],
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
  // `review_interface_link` is a problem card's own action only: an info
  // problem never decides the primary action.
  expect(new Set(ROWS.map((row) => row.action))).toEqual(
    new Set(CAPSULE_APP_ACTIONS.filter((action) => action !== "review_interface_link")),
  );
  expect(new Set(ROWS.flatMap((row) => row.problems))).toEqual(
    new Set(CAPSULE_APP_PROBLEM_CODES),
  );
});

test("link problems identify the requirement to repair and preserve approval warnings", () => {
  const derived = deriveCapsuleAppStatus(facts({
    interfaceLinks: [
      { ...LINK, health: "provider_removed" },
      { ...LINK, linkId: "ifl_pending", requirementKey: "pending", state: "pending_approval" },
      { ...LINK, linkId: "ifl_revoked", requirementKey: "revoked", state: "revoked" },
      { ...LINK, linkId: "ifl_declined", requirementKey: "declined", state: "declined" },
    ],
  }));
  expect(derived.primaryAction).toBe("fix_interface_link");
  expect(derived.problems[0]).toEqual({
    code: "interface_link_unavailable",
    severity: "error",
    requirementKey: "data",
    interfaceLinkId: "ifl_app",
    providerCapsuleId: "cap_provider",
  });
  expect(derived.problems.slice(1).map((problem) => [problem.code, problem.severity])).toEqual([
    ["interface_link_unset", "warning"],
    ["interface_link_unset", "warning"],
    ["interface_link_unset", "warning"],
  ]);
});

test("a link request stays below run, install and link problems and is offered only when approvable", () => {
  const failed = deriveCapsuleAppStatus(facts({
    latestRun: run({ status: "failed" }),
    interfaceLinks: [{ ...LINK, state: "unset", generation: 0 }],
    interfaceLinkRequests: [REQUEST, { ...REQUEST, linkId: "ifl_request_two", consumerCapsuleId: "cap_requester_two" }],
  }));
  expect(failed.primaryAction).toBe("retry");
  expect(failed.problems.map((problem) => problem.code)).toEqual([
    "run_failed", "interface_link_unset", "interface_link_approval_pending", "interface_link_approval_pending",
  ]);
  expect(failed.problems.slice(2)).toEqual([
    { code: "interface_link_approval_pending", severity: "info", requirementKey: "data", interfaceLinkId: "ifl_request", consumerCapsuleId: "cap_requester" },
    { code: "interface_link_approval_pending", severity: "info", requirementKey: "data", interfaceLinkId: "ifl_request_two", consumerCapsuleId: "cap_requester_two" },
  ]);
  const stalled = deriveCapsuleAppStatus(facts({ capsule: UNAPPLIED, interfaceLinkRequests: [REQUEST], now: Date.parse(UNAPPLIED.updatedAt) + 24 * 60 * 60 * 1000 }));
  expect(stalled.problems.map((problem) => problem.code)).toEqual(["install_incomplete", "interface_link_approval_pending"]);
  expect(stalled.primaryAction).toBe("continue_install");
  const notApprovable = deriveCapsuleAppStatus(facts({ interfaceLinkRequests: [{ ...REQUEST, canApprove: false }, { ...REQUEST, state: "active" }] }));
  expect(notApprovable.problems).toEqual([]);
});

test("a failed run takes priority over link repair, while an unapplied plan keeps review primary", () => {
  const failed = deriveCapsuleAppStatus(facts({
    latestRun: run({ status: "failed" }),
    interfaceLinks: [{ ...LINK, health: "provider_removed" }],
  }));
  expect(failed.primaryAction).toBe("retry");
  expect(failed.problems.map((problem) => problem.code)).toEqual([
    "run_failed", "interface_link_unavailable",
  ]);
  const reviewing = deriveCapsuleAppStatus(facts({
    capsule: UNAPPLIED,
    latestRun: run({ type: "plan", status: "succeeded" }),
    interfaceLinks: [{ ...LINK, health: "provider_removed" }],
  }));
  expect(reviewing.primaryAction).toBe("review");
  expect(reviewing.state).toBe("installing");
  const transient = deriveCapsuleAppStatus(facts({
    interfaceLinks: [{ ...LINK, health: "provider_not_ready" }],
  }));
  expect(transient.problems[0]?.severity).toBe("warning");
});

test("an unapplied review does not hide connection or Capsule errors", () => {
  const review = run({ type: "plan", status: "succeeded" });
  const connection = deriveCapsuleAppStatus(facts({
    capsule: UNAPPLIED,
    latestRun: review,
    connectionIssues: [{ provider: "test/provider", status: "missing" }],
    interfaceLinks: [{ ...LINK, health: "provider_removed" }],
  }));
  expect(connection.state).toBe("needs_attention");
  expect(connection.primaryAction).toBe("fix_connection");
  expect(connection.problems.map((problem) => problem.code)).toEqual([
    "connection_unavailable", "interface_link_unavailable",
  ]);
  const errored = deriveCapsuleAppStatus(facts({
    capsule: { ...UNAPPLIED, status: "error" },
    latestRun: review,
  }));
  expect(errored.state).toBe("needs_attention");
  expect(errored.primaryAction).toBe("retry");
  expect(errored.problems[0]?.code).toBe("capsule_error");
});

test("problems carry the exact Run, connection, blocked reason and teardown Run", () => {
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
    capsule: TEARDOWN_FAILED,
    latestRun: run({ id: "run_destroy", type: "destroy_apply", status: "failed" }),
  }));
  expect(teardown.problems[0]).toEqual({
    code: "uninstall_failed",
    severity: "error",
    runId: "run_destroy",
    runType: "destroy_apply",
  });
  const blocked = deriveCapsuleAppStatus(facts({
    capsule: uninstalled(
      advance(WITH_PLAN, { blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.planNotDeleteOnly }),
    ),
    uninstallCancellable: true,
  }));
  expect(blocked.problems).toEqual([
    {
      code: "uninstall_blocked",
      severity: "error",
      reason: "destroy_plan_not_delete_only",
      runId: "plan_finalizer",
      runType: "destroy_plan",
    },
  ]);
});

test("an uninstall record is live only while uninstalled or right after a failed teardown", () => {
  expect(liveCapsuleUninstall({ status: "uninstalled", uninstall: SCHEDULED }, undefined)).toBe(SCHEDULED);
  expect(
    liveCapsuleUninstall({ status: "error", uninstall: DESTROYING }, { type: "destroy_apply" }),
  ).toBe(DESTROYING);
  expect(
    liveCapsuleUninstall({ status: "error", uninstall: DESTROYING }, { type: "plan" }),
  ).toBeUndefined();
  expect(
    liveCapsuleUninstall({ status: "active", uninstall: DESTROYING }, { type: "destroy_apply" }),
  ).toBeUndefined();
  expect(
    liveCapsuleUninstall(
      { status: "active", uninstall: advance(SCHEDULED, { phase: "destroying" }) },
      undefined,
    ),
  ).toBeUndefined();
});
