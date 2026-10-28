/**
 * The install page's state (TASK-0115): what one attempt answer from the
 * install-plan coordinator plus the page's own state shows on the one
 * install screen, and the value-free requests the page may send.
 */
import { describe, expect, test } from "bun:test";
import type {
  GitInstallPlan,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanInterfaceRequirement,
  GitInstallPlanResponse,
  GitInstallPlanUserAction,
} from "takosumi-contract";
import {
  appNameFromText,
  appNameValue,
  attemptBelongsHere,
  attemptCreateRequest,
  attemptPastInputs,
  attemptProblemKey,
  bindingsWith,
  canAdvance,
  continueVariables,
  deriveInstallView,
  installAttemptId,
  legacyCapsuleLocator,
  missingConnections,
  interfaceLinksWith,
  missingInterfaces,
  retainedInterfaceLinks,
  withInterfaceOverrides,
  openAttemptStatusKey,
  progressSignature,
  replanRequest,
  repositoryLabel,
  restartRequest,
  retainedBindings,
  withConnectionOverrides,
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
    interfaces: [],
    variables: [],
    name: { current: "office", proposed: "office", conflict: false },
    missing: [],
    ...overrides,
  };
}

const candidate = { id: "conn_a", displayName: "My Cloudflare", status: "verified", scope: "workspace" } as const;

const linkedApp = { id: "if_a", name: "Chat", capsuleId: "cap_chat", capsuleName: "chat" } as const;
const interfaceRequirement: GitInstallPlanInterfaceRequirement = {
  requirementKey: "chat", type: "chat", version: "1", permissions: ["send"],
  candidates: [linkedApp], choice: { kind: "interface", interfaceId: "if_a" }, autoSelected: true,
};

describe("linked app answers", () => {
  test("each row needs a live choice or later, including the coordinator's missing flag", () => {
    const unselected = { ...interfaceRequirement, candidates: [linkedApp, { ...linkedApp, id: "if_b" }], choice: undefined, autoSelected: false };
    expect(missingInterfaces([unselected])).toEqual([unselected]);
    expect(missingInterfaces([interfaceRequirement, { ...unselected, choice: { kind: "later" } }])).toEqual([]);
    expect(missingInterfaces([{ ...interfaceRequirement, candidates: [] }])).toHaveLength(1);
    expect(deriveInstallView(respond(inputs({ interfaces: [unselected], missing: ["interfaces"] })), { armed: true }))
      .toMatchObject({ readyToConfirm: false, applyBlock: "interfaces", primaryBlocked: true });
    expect(deriveInstallView(respond(inputs({ missing: ["interfaces"] })), { armed: true }).readyToConfirm).toBe(false);
  });

  test("a full replacement keeps explicit answers and leaves automatic rows automatic", () => {
    const second = { ...interfaceRequirement, requirementKey: "mail", autoSelected: false, choice: { kind: "later" } as const };
    expect(interfaceLinksWith([interfaceRequirement, second], "mail", { kind: "interface", interfaceId: "if_a" }))
      .toEqual([{ requirementKey: "mail", choice: { kind: "interface", interfaceId: "if_a" } }]);
    expect(retainedInterfaceLinks(withInterfaceOverrides([interfaceRequirement, second], { chat: { kind: "later" } })))
      .toEqual([{ requirementKey: "chat", choice: { kind: "later" } }, { requirementKey: "mail", choice: { kind: "later" } }]);
    const implicitLater = { ...second, requirementKey: "no-candidate", candidates: [] };
    expect(interfaceLinksWith([interfaceRequirement, implicitLater, second], "mail", { kind: "later" }))
      .toEqual([{ requirementKey: "mail", choice: { kind: "later" } }]);
    expect(retainedInterfaceLinks([interfaceRequirement, implicitLater])).toEqual([]);
    expect(retainedInterfaceLinks([implicitLater], [{ requirementKey: "no-candidate", choice: { kind: "later" } }]))
      .toEqual([{ requirementKey: "no-candidate", choice: { kind: "later" } }]);
  });

  test("restart retains only explicit app choices while replan keeps the current sheet", () => {
    const interfaceLinks = [{ requirementKey: "chat", choice: { kind: "later" } as const }];
    expect(restartRequest(plan({ options: { interfaceLinks } })).options?.interfaceLinks).toEqual(interfaceLinks);
    expect(restartRequest(plan({ options: { interfaceLinks }, implicitInterfaceKeys: ["chat"] })).options?.interfaceLinks).toEqual([]);
    const mixed = [
      ...interfaceLinks,
      { requirementKey: "mail", choice: { kind: "interface" as const, interfaceId: "if_a" } },
    ];
    expect(restartRequest(plan({ options: { interfaceLinks: mixed }, implicitInterfaceKeys: ["chat"] })).options?.interfaceLinks)
      .toEqual([mixed[1]]);
    expect(replanRequest(plan(), { name: "office", ref: COMMIT, providerBindings: [], interfaceLinks }).options?.interfaceLinks).toEqual(interfaceLinks);
  });

  test("progress includes linked app candidates, answers, and permissions", () => {
    const base = respond(inputs({ interfaces: [interfaceRequirement] }));
    for (const row of [
      { ...interfaceRequirement, choice: { kind: "later" } as const },
      { ...interfaceRequirement, candidates: [] },
      { ...interfaceRequirement, permissions: ["read"] },
    ]) expect(progressSignature(respond(inputs({ interfaces: [row] })))).not.toBe(progressSignature(base));
  });
});

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

  test("recreating an install retains its environment even without an explicit name", () => {
    const candidate = { url: "https://x.example/r.git", ref: "", sourcePath: ".", modulePath: "" };
    expect(attemptCreateRequest({ ...candidate, environment: "integration" })).toEqual({
      mode: "attempt",
      source: { url: candidate.url },
      capsule: { environment: "integration" },
    });
    expect(attemptCreateRequest({ ...candidate, name: "office", environment: "integration" }).capsule).toEqual({
      name: "office",
      environment: "integration",
    });
    expect(attemptCreateRequest({ ...candidate, name: "office" }).capsule).toEqual({ name: "office" });
    expect(attemptCreateRequest(candidate).capsule).toBeUndefined();
  });

  test("Restart retains the existing integration environment", () => {
    expect(restartRequest(plan({ capsule: { name: "office", environment: "integration" } })).capsule).toEqual({
      name: "office",
      environment: "integration",
    });
  });

  test("starting over reads the same app, version, module and name again", () => {
    expect(restartRequest(plan({ options: { modulePath: "infra", providerBindings: [{ provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "conn_a" }] } }))).toEqual({
      mode: "attempt",
      source: { url: "https://github.com/example/office.git", ref: COMMIT },
      capsule: { name: "office", environment: "production" },
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
    expect(attemptProblemKey("interface_link_unavailable")).toBe("installStore.problem.interfaceUnavailable");
    expect(attemptProblemKey("interface_choice_conflict")).toBe("installStore.problem.interfaceConflict");
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

describe("the one install screen", () => {
  test("「許可してインストール」 waits with one reason until the Plan is ready", () => {
    const missing = inputs({ connections: [requirement({ candidates: [candidate] })], missing: ["connections"] });
    const secret = inputs({ variables: [{ name: "api_token", type: "string", required: true, sensitive: true }] });
    const cases: [string, ReturnType<typeof deriveInstallView>, string | undefined, string | undefined][] = [
      ["starting", deriveInstallView(undefined, { starting: true }), "reading", "reading"],
      ["reading", deriveInstallView(respond({ kind: "wait", phase: "syncing_source" }, { phase: "syncing_source" }), { driving: true }), "reading", "reading"],
      ["analyzing", deriveInstallView(respond({ kind: "wait", phase: "analyzing_compatibility" }, { phase: "analyzing_compatibility" }), { driving: true }), "reading", "analyzing"],
      ["planning", deriveInstallView(respond({ kind: "wait", phase: "planning" }, { phase: "planning" }), { driving: true }), "checking", "planning"],
      ["paused", deriveInstallView(respond({ kind: "wait", phase: "planning" }, { phase: "planning" })), "paused", "paused"],
      ["module", deriveInstallView(respond({ kind: "choose_module", modules: [{ path: "a", providers: [] }, { path: "b", providers: [] }] })), "module", undefined],
      ["connection", deriveInstallView(respond(missing), { armed: true }), "connections", undefined],
      ["setting", deriveInstallView(respond(secret), { armed: true }), "settings", undefined],
      ["invalid name", deriveInstallView(respond(inputs()), { armed: true, name: "Not Valid" }), "invalid", undefined],
      ["complete", deriveInstallView(respond(inputs()), { armed: true }), "checking", "planning"],
      ["confirming", deriveInstallView(respond(inputs()), { confirming: true }), "checking", "planning"],
      ["review", deriveInstallView(respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_a" }, { phase: "reviewable" })), undefined, undefined],
    ];
    for (const [label, view, block, progress] of cases) {
      expect({ label, block: view.applyBlock, progress: view.progress }).toEqual({ label, block, progress });
    }
  });

  test("a reopened complete sheet waits for the person instead of being confirmed", () => {
    const reopened = deriveInstallView(respond(inputs()));
    expect(reopened).toMatchObject({ readyToConfirm: true, applyBlock: "paused", progress: "paused" });
    expect(deriveInstallView(respond(inputs()), { armed: true })).toMatchObject({ readyToConfirm: true, applyBlock: "checking" });
  });

  test("only a complete sheet is ready to confirm", () => {
    expect(deriveInstallView(respond(inputs())).readyToConfirm).toBe(true);
    expect(deriveInstallView(respond(inputs({ connections: [requirement()], missing: ["connections"] }))).readyToConfirm).toBe(false);
    expect(deriveInstallView(respond(inputs({ name: { current: "office", proposed: "office-2", conflict: true }, missing: ["name"] }))).readyToConfirm).toBe(false);
    const secret = inputs({ variables: [{ name: "api_token", type: "string", required: true, sensitive: true }] });
    expect(deriveInstallView(respond(secret)).readyToConfirm).toBe(false);
    expect(deriveInstallView(respond(secret), { drafts: { api_token: { value: "s3cret", touched: true } } }).readyToConfirm).toBe(true);
    expect(deriveInstallView(respond({ kind: "wait", phase: "planning" })).readyToConfirm).toBe(false);
  });

  test("a change after the Plan reads as preparing again until the new Plan or the person is needed", () => {
    const review = respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_a" }, { phase: "reviewable" });
    expect(deriveInstallView(review, { outdated: true })).toMatchObject({ stage: "review", applyBlock: "replanning", progress: "replanning" });
    // The replacing attempt reads the repository and plans as one step…
    const reading = respond({ kind: "wait", phase: "syncing_source" }, { phase: "syncing_source" });
    expect(deriveInstallView(reading, { driving: true, replanning: true })).toMatchObject({ applyBlock: "replanning", progress: "replanning" });
    expect(deriveInstallView(respond(inputs()), { armed: true, replanning: true })).toMatchObject({ applyBlock: "replanning" });
    // …until it needs the person again or its Plan is ready.
    const missing = inputs({ connections: [requirement()], missing: ["connections"] });
    expect(deriveInstallView(respond(missing), { replanning: true })).toMatchObject({ applyBlock: "connections" });
    expect(deriveInstallView(review, { replanning: true }).applyBlock).toBeUndefined();
    // A problem is a problem, not a step.
    const failed = respond({ kind: "retry", code: "plan_run_failed", restart: true }, { phase: "failed" });
    expect(deriveInstallView(failed, { outdated: true, replanning: true })).toMatchObject({ stage: "failed" });
    expect(deriveInstallView(failed, { outdated: true }).applyBlock).toBeUndefined();
  });
});

describe("answers kept when the install is prepared again", () => {
  const rows = [
    requirement({ candidates: [candidate], selectedConnectionId: "conn_a", autoSelected: true }),
    requirement({ moduleLocalName: "cloudflare", childAlias: "dns", rootAlias: "dns", candidates: [candidate, { ...candidate, id: "conn_b", displayName: "B" }] }),
  ];

  test("choices made after the Plan show on top of the coordinator's selection", () => {
    const shown = withConnectionOverrides(rows, { [`${CLOUDFLARE}|cloudflare|dns|dns`]: "conn_b" });
    expect(shown[0]).toEqual(rows[0]);
    expect(shown[1]).toMatchObject({ selectedConnectionId: "conn_b", autoSelected: false });
    const cleared = withConnectionOverrides(rows, { [`${CLOUDFLARE}|cloudflare||`]: "" });
    expect(cleared[0]?.selectedConnectionId).toBeUndefined();
    expect(missingConnections(cleared)).toHaveLength(2);
  });

  test("every chosen connection is carried as an exact provider tuple", () => {
    const shown = withConnectionOverrides(rows, { [`${CLOUDFLARE}|cloudflare|dns|dns`]: "conn_b" });
    expect(retainedBindings(shown)).toEqual([
      { provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "conn_a" },
      { provider: CLOUDFLARE, moduleLocalName: "cloudflare", childAlias: "dns", rootAlias: "dns", connectionId: "conn_b" },
    ]);
    expect(retainedBindings(rows)).toHaveLength(1);
  });

  test("the new attempt reads the same repository with the person's name, version, module and connections", () => {
    const original = plan({ source: { name: "office", url: "https://github.com/example/office.git", ref: COMMIT, path: "apps", authConnectionId: "conn_git" } });
    const bindings = [{ provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "conn_a" }];
    expect(replanRequest(original, { name: "office-two", ref: COMMIT, modulePath: "deploy", providerBindings: bindings })).toEqual({
      mode: "attempt",
      source: { url: "https://github.com/example/office.git", ref: COMMIT, path: "apps", authConnectionId: "conn_git" },
      capsule: { name: "office-two", environment: "production" },
      options: { modulePath: "deploy", providerBindings: bindings },
    });
    // The repository default stays the default; no setting value is ever part of it.
    const request = replanRequest(plan({ source: { ...original.source, ref: "HEAD", path: "." } }), { name: "office", ref: "HEAD", providerBindings: [] });
    expect(request).toEqual({ mode: "attempt", source: { url: "https://github.com/example/office.git", authConnectionId: "conn_git" }, capsule: { name: "office", environment: "production" } });
    expect(JSON.stringify(request)).not.toContain("variables");
  });

  test("replanning after edits retains integration while replacing the name and module", () => {
    const request = replanRequest(plan({ capsule: { name: "office", environment: "integration" } }), {
      name: "office-two",
      ref: "v2.0.0",
      modulePath: "deploy",
      providerBindings: [],
    });
    expect(request.capsule).toEqual({ name: "office-two", environment: "integration" });
    expect(request.source.ref).toBe("v2.0.0");
    expect(request.options).toEqual({ modulePath: "deploy" });
  });
});

describe("what holds 「許可してインストール」 after a change", () => {
  const review = respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_a" }, { phase: "reviewable" });

  test("only phases after the sheet date a Plan", () => {
    for (const phase of ["creating_capsule", "planning", "reviewable", "failed"] as const) expect(attemptPastInputs(phase)).toBe(true);
    for (const phase of ["syncing_source", "compiling_install", "analyzing_compatibility", "awaiting_input", "discarded"] as const) {
      expect(attemptPastInputs(phase)).toBe(false);
    }
    expect(attemptPastInputs(undefined)).toBe(false);
  });

  test("a field being typed in holds the apply and the confirmation", () => {
    expect(deriveInstallView(review, { editing: true }).applyBlock).toBe("editing");
    expect(deriveInstallView(respond(inputs()), { armed: true, editing: true }).applyBlock).toBe("editing");
    // Reading is reading, whatever is typed meanwhile.
    expect(deriveInstallView(respond({ kind: "wait", phase: "syncing_source" }, { phase: "syncing_source" }), { driving: true, editing: true }).applyBlock).toBe("reading");
  });

  test("an out-of-date Plan is held: by an invalid name, by typing, or until preparing again is continued", () => {
    expect(deriveInstallView(review, { outdated: true, nameInvalid: true })).toMatchObject({ applyBlock: "invalid" });
    expect(deriveInstallView(review, { outdated: true, nameInvalid: true }).progress).toBeUndefined();
    expect(deriveInstallView(review, { outdated: true, editing: true })).toMatchObject({ applyBlock: "editing" });
    expect(deriveInstallView(review, { outdated: true, replanStalled: true })).toMatchObject({ applyBlock: "paused", progress: "replanPaused" });
    expect(deriveInstallView(review, { outdated: true })).toMatchObject({ applyBlock: "replanning", progress: "replanning" });
  });

  test("a Plan that failed stays on the screen only while the answers are kept", () => {
    const failed = respond({ kind: "retry", code: "plan_run_failed", restart: true }, { phase: "failed" });
    expect(deriveInstallView(failed, { answersKept: true })).toMatchObject({ stage: "failed", applyBlock: "failed", progress: "failed", retryCode: "plan_run_failed" });
    expect(deriveInstallView(failed, { answersKept: true, outdated: true })).toMatchObject({ applyBlock: "replanning" });
    expect(deriveInstallView(failed).applyBlock).toBeUndefined();
  });
});
