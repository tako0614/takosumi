/**
 * The install page's state (TASK-0115 Phase 3b): what one attempt answer
 * from the install-plan coordinator plus the page's own state shows, and the
 * value-free requests the page may send.
 */
import { describe, expect, test } from "bun:test";
import type {
  GitInstallPlan,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanResponse,
  GitInstallPlanUserAction,
} from "takosumi-contract";
import {
  appNameFromText,
  appNameValue,
  attemptBelongsHere,
  attemptCreateRequest,
  attemptProblemKey,
  bindingsWith,
  canAdvance,
  continueVariables,
  deriveInstallView,
  installAttemptId,
  legacyCapsuleLocator,
  missingConnections,
  openAttemptStatusKey,
  progressSignature,
  repositoryLabel,
  restartRequest,
  sheetVariables,
  variableInitialText,
  versionLabel,
  withInstallAttempt,
  withoutInstallContext,
  type InstallPrimary,
} from "../../../../../dashboard/src/views/new/install-attempt.ts";

const ID = "gip_0123456789abcdef";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";

function plan(overrides: Partial<GitInstallPlan> = {}): GitInstallPlan {
  return {
    id: ID,
    workspaceId: "ws_alpha",
    createdBy: "sub_me",
    operation: "install",
    mode: "attempt",
    requestDigest: "sha256:x",
    source: { name: "office", url: "https://github.com/example/office.git", ref: COMMIT, path: "." },
    capsule: { name: "office", environment: "production" },
    options: {},
    phase: "awaiting_input",
    generation: 3,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function respond(
  userAction: GitInstallPlanUserAction,
  overrides: Partial<GitInstallPlan> = {},
  invalidated?: GitInstallPlanResponse["invalidated"],
): GitInstallPlanResponse {
  return {
    installPlan: plan(overrides),
    nextAction: userAction.kind === "wait" ? "reconcile" : userAction.kind === "review_run" ? "review_run" : "none",
    userAction,
    ...(invalidated ? { invalidated } : {}),
    links: { self: `/api/v1/install-plans/${ID}` },
  };
}

function requirement(
  overrides: Partial<GitInstallPlanConnectionRequirement> = {},
): GitInstallPlanConnectionRequirement {
  return {
    provider: CLOUDFLARE,
    moduleLocalName: "cloudflare",
    candidates: [],
    autoSelected: false,
    ...overrides,
  };
}

type ProvideInputs = Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>;

function inputs(overrides: Partial<ProvideInputs> = {}): ProvideInputs {
  return {
    kind: "provide_inputs",
    modulePath: ".",
    resources: [{ type: "cloudflare_workers_script", allowed: true }],
    connections: [],
    variables: [],
    name: { current: "office", proposed: "office", conflict: false },
    missing: [],
    ...overrides,
  };
}

const candidate = { id: "conn_a", displayName: "My Cloudflare", status: "verified", scope: "workspace" } as const;

describe("one primary action per state", () => {
  const cases: [string, GitInstallPlanResponse | undefined, Parameters<typeof deriveInstallView>[1], string, InstallPrimary][] = [
    ["not installed", undefined, {}, "candidate", "install"],
    ["the URL's attempt is still loading", undefined, { loading: true }, "loading", "none"],
    ["starting", undefined, { starting: true, mutating: true }, "starting", "none"],
    ["reading while this page follows it", respond({ kind: "wait", phase: "syncing_source" }), { driving: true }, "reading", "none"],
    ["reopened while the coordinator has work left", respond({ kind: "wait", phase: "planning" }), {}, "paused", "continue"],
    ["module choice", respond({ kind: "choose_module", modules: [{ path: ".", providers: [] }] }), {}, "choose_module", "choose_module"],
    ["a connection is missing", respond(inputs({ connections: [requirement()], missing: ["connections"] })), {}, "provide_inputs", "connect"],
    ["everything answered", respond(inputs()), {}, "provide_inputs", "review"],
    ["review owns the apply click", respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_a" }, { phase: "reviewable" }), {}, "review", "none"],
    ["a step to try again", respond({ kind: "retry", code: "install_plan_reconcile_retryable", restart: false }, { phase: "planning" }), {}, "retry", "retry"],
    ["a failed attempt", respond({ kind: "retry", code: "source_sync_failed", restart: true }, { phase: "failed" }), {}, "failed", "restart"],
    ["an expired attempt", respond({ kind: "retry", code: "install_attempt_expired", restart: true }, {}, "install_attempt_expired"), {}, "invalidated", "restart"],
    ["a discarded attempt", respond({ kind: "none" }, { phase: "discarded" }), {}, "discarded", "reinstall"],
    ["an attempt that cannot be read", undefined, { loadFailed: true }, "unavailable", "reload"],
  ];
  for (const [name, response, local, stage, primary] of cases) {
    test(name, () => {
      const view = deriveInstallView(response, local);
      expect({ stage: view.stage, primary: view.primary }).toEqual({ stage, primary });
    });
  }

  test("applying is never a primary action of the page itself", () => {
    const primaries = cases.map(([, response, local]) => deriveInstallView(response, local).primary);
    for (const primary of primaries) expect(primary).not.toMatch(/apply|allow/u);
  });

  test("nothing can be pressed twice while a request is in flight", () => {
    const answering = { mutating: true } as const;
    expect(deriveInstallView(respond(inputs()), answering).primaryBlocked).toBe(true);
    expect(deriveInstallView(respond(inputs()), answering).canDiscard).toBe(false);
    expect(deriveInstallView(respond({ kind: "wait", phase: "planning" }), answering).primaryBlocked).toBe(true);
    // Following the coordinator is not a request the person made: stopping stays offered.
    expect(deriveInstallView(respond({ kind: "wait", phase: "planning" }), { driving: true }).canDiscard).toBe(true);
  });

  test("nothing starts while the URL's attempt loads", () => {
    expect(deriveInstallView(undefined, { loading: true })).toMatchObject({ primaryBlocked: true, canDiscard: false });
  });

  test("a sheet answer in flight leaves Review pressable (it waits) but not Stop", () => {
    const answering = deriveInstallView(respond(inputs()), { answering: true });
    expect(answering).toMatchObject({ primary: "review", primaryBlocked: false, canDiscard: false });
    expect(deriveInstallView(respond({ kind: "choose_module", modules: [{ path: ".", providers: [] }] }), { answering: true }).primaryBlocked).toBe(true);
  });

  test("a step to try again reads as reading while the page retries it", () => {
    const retryable = respond({ kind: "retry", code: "install_plan_reconcile_retryable", restart: false }, { phase: "planning" });
    expect(deriveInstallView(retryable, { driving: true })).toMatchObject({ stage: "reading", primary: "none" });
  });

  test("an attempt that is already discarded offers no discard", () => {
    expect(deriveInstallView(respond({ kind: "none" }, { phase: "discarded" })).canDiscard).toBe(false);
  });
});

describe("the sheet", () => {
  test("a required setting blocks review until it has a value", () => {
    const action = inputs({
      variables: [{ name: "api_token", type: "string", required: true, sensitive: true }],
    });
    const blocked = deriveInstallView(respond(action));
    expect(blocked).toMatchObject({ primary: "review", primaryBlocked: true, missingVariables: ["api_token"] });
    const ready = deriveInstallView(respond(action), { drafts: { api_token: { value: "s3cret", touched: true } } });
    expect(ready).toMatchObject({ primary: "review", primaryBlocked: false, missingVariables: [] });
  });

  test("a taken or invalid name blocks review", () => {
    const taken = respond(inputs({ name: { current: "office", proposed: "office-2", conflict: true }, missing: ["name"] }));
    expect(deriveInstallView(taken)).toMatchObject({ nameProblem: "conflict", primaryBlocked: true });
    expect(deriveInstallView(taken, { name: "office-2" }).nameProblem).toBeUndefined();
    expect(deriveInstallView(respond(inputs()), { name: "Not A Name" })).toMatchObject({ nameProblem: "invalid", primaryBlocked: true });
  });

  test("a missing connection asks to connect before anything else", () => {
    const view = deriveInstallView(respond(inputs({
      connections: [requirement()],
      variables: [{ name: "domain", type: "string", required: true, sensitive: false }],
    })));
    expect(view.primary).toBe("connect");
    expect(view.primaryBlocked).toBe(false);
    expect(view.missingConnections).toHaveLength(1);
  });

  test("a stale selection that is no longer offered counts as missing", () => {
    const stale = requirement({ candidates: [candidate], selectedConnectionId: "conn_revoked" });
    expect(missingConnections([stale])).toEqual([stale]);
    expect(missingConnections([requirement({ candidates: [candidate], selectedConnectionId: "conn_a" })])).toEqual([]);
  });

  test("while values must be sent again, only those are asked and nothing else can change", () => {
    const action = inputs({
      connections: [requirement()],
      variables: [{ name: "domain", type: "string", required: false, sensitive: false, defaultValue: "a.example" }],
      resubmitVariables: ["api_token"],
      name: { current: "office", proposed: "office-2", conflict: true },
    });
    expect(sheetVariables(action)).toEqual([{ name: "api_token", type: "unknown", required: true, sensitive: true }]);
    const view = deriveInstallView(respond(action), { name: "renamed" });
    expect(view).toMatchObject({ primary: "review", missingConnections: [], missingVariables: ["api_token"] });
    expect(view.nameProblem).toBeUndefined();
    // An empty resubmission list still means nothing else may change.
    expect(sheetVariables(inputs({ variables: action.variables, resubmitVariables: [] }))).toEqual([]);
  });
});

describe("setting values", () => {
  const action = inputs({
    variables: [
      { name: "api_token", type: "string", required: true, sensitive: true },
      { name: "domain", type: "string", required: false, sensitive: false, defaultValue: "default.example" },
      { name: "service_name", type: "string", required: false, sensitive: false, derivedDefault: "capsule_name" },
      { name: "replicas", type: "number", required: false, sensitive: false },
      { name: "public", type: "boolean", required: false, sensitive: false },
      { name: "labels", type: "json", required: false, sensitive: false },
    ],
  });

  test("secret fields start empty and defaults are only shown", () => {
    expect(variableInitialText({ name: "x", type: "string", required: false, sensitive: true, defaultValue: "leak" })).toBe("");
    expect(variableInitialText(action.variables[1]!)).toBe("default.example");
    expect(variableInitialText({ name: "n", type: "number", required: false, sensitive: false, defaultValue: 3 })).toBe("3");
  });

  test("only typed secrets and edited values are sent; untouched defaults stay Takosumi's", () => {
    expect(continueVariables(action, { api_token: { value: "s3cret", touched: true } })).toEqual({
      ok: true,
      variables: { api_token: "s3cret" },
    });
    expect(continueVariables(action, {
      api_token: { value: "s3cret", touched: true },
      domain: { value: "chosen.example", touched: true },
      replicas: { value: "2", touched: true },
      public: { value: "true", touched: true },
      labels: { value: "{\"team\":\"a\"}", touched: true },
    })).toEqual({
      ok: true,
      variables: { api_token: "s3cret", domain: "chosen.example", replicas: 2, public: true, labels: { team: "a" } },
    });
  });

  test("an emptied optional value falls back to its default instead of being sent", () => {
    expect(continueVariables(action, {
      api_token: { value: "s3cret", touched: true },
      domain: { value: "", touched: true },
    })).toEqual({ ok: true, variables: { api_token: "s3cret" } });
  });

  test("missing and malformed values are named, never sent", () => {
    expect(continueVariables(action, {
      replicas: { value: "two", touched: true },
      labels: { value: "{", touched: true },
    })).toEqual({ ok: false, missing: ["api_token"], invalid: ["replicas", "labels"] });
  });
});

describe("connection answers", () => {
  const auto = requirement({ moduleLocalName: "auto", candidates: [candidate], selectedConnectionId: "conn_a", autoSelected: true });
  const chosen = requirement({ moduleLocalName: "chosen", childAlias: "eu", rootAlias: "eu", candidates: [candidate], selectedConnectionId: "conn_a" });
  const open = requirement({ moduleLocalName: "open", candidates: [candidate, { ...candidate, id: "conn_b" }] });

  test("one choice replaces the complete explicit answer and keeps automatic rows automatic", () => {
    expect(bindingsWith([auto, chosen, open], open, "conn_b")).toEqual([
      { provider: CLOUDFLARE, moduleLocalName: "chosen", childAlias: "eu", rootAlias: "eu", connectionId: "conn_a" },
      { provider: CLOUDFLARE, moduleLocalName: "open", connectionId: "conn_b" },
    ]);
  });

  test("clearing a choice removes only that row", () => {
    expect(bindingsWith([auto, chosen, open], chosen, "")).toEqual([]);
  });
});

describe("starting and starting over", () => {
  test("Install sends only the Git address and what the link or listing named", () => {
    expect(attemptCreateRequest({ url: " https://github.com/example/office.git ", ref: "", sourcePath: ".", modulePath: "" })).toEqual({
      mode: "attempt",
      source: { url: "https://github.com/example/office.git" },
    });
    expect(attemptCreateRequest({
      url: "https://github.com/example/office.git",
      ref: "v1.2.0",
      sourcePath: "deploy",
      modulePath: "infra",
      name: "office",
      authConnectionId: "conn_git",
    })).toEqual({
      mode: "attempt",
      source: { url: "https://github.com/example/office.git", ref: "v1.2.0", path: "deploy", authConnectionId: "conn_git" },
      capsule: { name: "office" },
      options: { modulePath: "infra" },
    });
  });

  test("a name the API would refuse is left to the coordinator to propose", () => {
    expect(attemptCreateRequest({ url: "https://x.example/r.git", ref: "", sourcePath: ".", modulePath: "", name: "Bad Name" }).capsule).toBeUndefined();
    expect(appNameFromText("Repository Office")).toBe("repository-office");
    expect(appNameValue("ok-name")).toBe("ok-name");
    expect(appNameValue("")).toBeUndefined();
  });

  test("starting over reads the same app, version, module and name again", () => {
    expect(restartRequest(plan({ options: { modulePath: "infra", providerBindings: [{ provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "conn_a" }] } }))).toEqual({
      mode: "attempt",
      source: { url: "https://github.com/example/office.git", ref: COMMIT },
      capsule: { name: "office" },
      options: { modulePath: "infra" },
    });
  });

  test("only this person's attempt in this workspace is shown", () => {
    const response = respond(inputs());
    const here = { attemptId: ID, workspaceId: "ws_alpha", principalId: "sub_me" };
    expect(attemptBelongsHere(response, here)).toBe(true);
    expect(attemptBelongsHere(response, { ...here, workspaceId: "ws_beta" })).toBe(false);
    expect(attemptBelongsHere(response, { ...here, principalId: "sub_other" })).toBe(false);
    expect(attemptBelongsHere(response, { ...here, attemptId: "gip_ffffffffffffffff" })).toBe(false);
    expect(attemptBelongsHere(respond(inputs(), { mode: undefined }), here)).toBe(false);
  });
});

describe("following the coordinator", () => {
  test("reconcile is sent for wait and for a retry without restart only", () => {
    expect(canAdvance(respond({ kind: "wait", phase: "planning" }))).toBe(true);
    expect(canAdvance(respond({ kind: "retry", code: "install_plan_reconcile_retryable", restart: false }))).toBe(true);
    expect(canAdvance(respond({ kind: "retry", code: "source_sync_failed", restart: true }))).toBe(false);
    expect(canAdvance(respond({ kind: "wait", phase: "planning" }, {}, "install_attempt_expired"))).toBe(false);
    expect(canAdvance(respond(inputs()))).toBe(false);
  });

  test("progress ignores the generation every claim bumps", () => {
    const waiting = respond({ kind: "wait", phase: "planning" }, { phase: "planning", generation: 4 });
    const claimed = respond({ kind: "wait", phase: "planning" }, { phase: "planning", generation: 5 });
    expect(progressSignature(claimed)).toBe(progressSignature(waiting));
    const planned = respond({ kind: "wait", phase: "planning" }, { phase: "planning", generation: 6, planRunId: "run_plan" });
    expect(progressSignature(planned)).not.toBe(progressSignature(waiting));
    const reviewable = respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_a" }, { phase: "reviewable" });
    expect(progressSignature(reviewable)).not.toBe(progressSignature(planned));
  });
});

describe("the URL holds only the attempt id", () => {
  test("the locator is one well-formed id", () => {
    expect(installAttemptId(`?installPlan=${ID}`)).toBe(ID);
    expect(installAttemptId(`?installPlan=${ID}&installPlan=${ID}`)).toBeUndefined();
    expect(installAttemptId("?installPlan=gip_not-an-id")).toBeUndefined();
    expect(() => withInstallAttempt("", "javascript:alert(1)")).toThrow();
  });

  test("setting and removing it keeps the app's own link", () => {
    const store = "?tcsBase=https%3A%2F%2Fstore.example&tcsListing=office&git=https%3A%2F%2Fgithub.com%2Fexample%2Foffice.git&name=office";
    const withAttempt = withInstallAttempt(store, ID);
    expect(installAttemptId(withAttempt)).toBe(ID);
    expect(withInstallAttempt(withAttempt, undefined)).toBe(store);
    expect(withoutInstallContext(withAttempt)).toBe("?git=https%3A%2F%2Fgithub.com%2Fexample%2Foffice.git&name=office");
  });

  test("no setting name or value can reach the URL helpers", () => {
    const search = withInstallAttempt("?git=https%3A%2F%2Fgithub.com%2Fexample%2Foffice.git", ID);
    expect([...new URLSearchParams(search).keys()].sort()).toEqual(["git", "installPlan"]);
  });

  test("an old app locator goes to that app's page", () => {
    expect(legacyCapsuleLocator("?capsule=cap_abc")).toBe("cap_abc");
    expect(legacyCapsuleLocator("?capsule=../x")).toBeUndefined();
  });
});

describe("words", () => {
  test("problems and statuses are localized by code with a generic fallback", () => {
    expect(attemptProblemKey("install_attempt_expired")).toBe("installStore.problem.expired");
    expect(attemptProblemKey("source_sync_failed")).toBe("installStore.problem.sourceSync");
    expect(attemptProblemKey("something_new")).toBe("installStore.problem.generic");
    expect(attemptProblemKey(undefined)).toBe("installStore.problem.generic");
    expect(openAttemptStatusKey(respond({ kind: "wait", phase: "syncing_source" }))).toBe("installStore.open.statusReading");
    expect(openAttemptStatusKey(respond(inputs()))).toBe("installStore.open.statusInputs");
    expect(openAttemptStatusKey(respond({ kind: "review_run", planRunId: "r", capsuleId: "c" }))).toBe("installStore.open.statusReview");
    expect(openAttemptStatusKey(respond({ kind: "retry", code: "install_attempt_expired", restart: true }, {}, "install_attempt_expired"))).toBe("installStore.open.statusExpired");
  });

  test("provenance reads as a person writes it", () => {
    expect(repositoryLabel("https://github.com/example/office.git")).toBe("github.com/example/office");
    expect(versionLabel(COMMIT)).toBe("0123456");
    expect(versionLabel("HEAD")).toBeUndefined();
    expect(versionLabel("v1.4.2")).toBe("v1.4.2");
  });
});
