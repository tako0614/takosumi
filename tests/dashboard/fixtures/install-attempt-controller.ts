/**
 * Behavior of the install page's attempt controller (TASK-0115) against a
 * scripted coordinator. Invoked by
 * tests/dashboard/src/views/new/install-attempt-controller_test.ts with
 * --conditions=browser so Solid's reactive build runs the effects.
 */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { GitInstallPlanInterfaceChoice, GitInstallPlanInterfaceLinkRequest, GitInstallPlanInterfaceRequirement, GitInstallPlanResponse, GitInstallPlanUserAction } from "takosumi-contract";

const dashboard = resolve(import.meta.dir, "../../../dashboard");
const solid = await import(resolve(dashboard, "node_modules/solid-js/dist/solid.js"));

const apiPath = resolve(dashboard, "src/lib/control-api.ts");
const api = await import(apiPath);

type Call = { readonly name: string; readonly args: readonly unknown[] };
const calls: Call[] = [];
let handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
let inFlight = 0;
let maxInFlight = 0;
let personalOwnership = false;
let discoverInstallWorkspace: ((workspaceId?: string) => Promise<string | undefined>) | undefined;

function scripted(name: string) {
  return async (...args: unknown[]) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected request: ${name}`);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await (handler as (...values: unknown[]) => Promise<unknown>)(...args);
    } finally {
      inFlight -= 1;
    }
  };
}

mock.module(apiPath, () => ({
  ...api,
  createGitInstallAttempt: scripted("createGitInstallAttempt"),
  listConnections: scripted("listConnections"),
  getGitInstallPlan: scripted("getGitInstallPlan"),
  reconcileGitInstallPlan: scripted("reconcileGitInstallPlan"),
  answerGitInstallAttempt: scripted("answerGitInstallAttempt"),
  discardGitInstallAttempt: scripted("discardGitInstallAttempt"),
  resolveStableSourceTag: scripted("resolveStableSourceTag"),
  appOwnershipAvailable: async () => personalOwnership,
  legacyInstallWorkspaceId: async (workspaceId?: string) => discoverInstallWorkspace
    ? await discoverInstallWorkspace(workspaceId)
    : personalOwnership ? undefined : workspaceId,
  // The real delay schedule is kept; the pause itself is virtual (see mount).
}));

const { setCurrentWorkspaceId } = await import(resolve(dashboard, "src/lib/workspace-state.ts"));
const { useInstallAttempt } = await import(resolve(dashboard, "src/views/new/use-install-attempt.ts"));
setCurrentWorkspaceId("ws_alpha");

const ID = "gip_0123456789abcdef";
const URL_ = "https://github.com/example/office.git";
const SECRET = "s3cret-value-never-elsewhere";

function respond(
  userAction: GitInstallPlanUserAction,
  generation: number,
  phase: string = userAction.kind === "wait" ? userAction.phase : userAction.kind === "review_run" ? "reviewable" : "awaiting_input",
  id: string = ID,
): GitInstallPlanResponse {
  return {
    installPlan: {
      id,
      workspaceId: "ws_alpha",
      createdBy: "sub_me",
      operation: "install",
      mode: "attempt",
      requestDigest: "sha256:x",
      source: { name: "office", url: URL_, ref: "HEAD", path: "." },
      capsule: { name: "office", environment: "production" },
      options: {},
      phase: phase as GitInstallPlanResponse["installPlan"]["phase"],
      generation,
      createdAt: "2026-10-28T00:00:00.000Z",
      updatedAt: "2026-10-28T00:00:00.000Z",
    },
    nextAction: userAction.kind === "wait" ? "reconcile" : "none",
    userAction,
    links: { self: `/api/v1/install-plans/${ID}` },
  };
}

function inIntegration(response: GitInstallPlanResponse): GitInstallPlanResponse {
  return {
    ...response,
    installPlan: { ...response.installPlan, capsule: { ...response.installPlan.capsule, environment: "integration" } },
  };
}

function withoutWorkspace(response: GitInstallPlanResponse): GitInstallPlanResponse {
  return { ...response, installPlan: { ...response.installPlan, workspaceId: "" } };
}

function withSourceRef(response: GitInstallPlanResponse, ref: string): GitInstallPlanResponse {
  const plan = response.installPlan;
  return { ...response, installPlan: { ...plan, source: { ...plan.source, ref } } };
}

const requirement = {
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  moduleLocalName: "cloudflare",
  candidates: [
    { id: "conn_a", displayName: "A", status: "verified", scope: "workspace" },
    { id: "conn_b", displayName: "B", status: "verified", scope: "workspace" },
  ],
  autoSelected: false,
} as const;

const linkedRequirement: GitInstallPlanInterfaceRequirement = {
  requirementKey: "chat", type: "chat", version: "1", permissions: ["send"],
  candidates: [
    { id: "if_a", name: "Chat A", capsuleId: "cap_a", capsuleName: "chat-a" },
    { id: "if_b", name: "Chat B", capsuleId: "cap_b", capsuleName: "chat-b" },
  ],
  autoSelected: false,
};

function inputs(overrides: Record<string, unknown> = {}): GitInstallPlanUserAction {
  return {
    kind: "provide_inputs",
    modulePath: ".",
    resources: [],
    connections: [requirement],
    interfaces: [],
    variables: [{ name: "api_token", type: "string", required: true, sensitive: true }],
    name: { current: "office", proposed: "office", conflict: false },
    missing: ["connections"],
    ...overrides,
  } as GitInstallPlanUserAction;
}

function reset(next: typeof handlers) {
  personalOwnership = false;
  discoverInstallWorkspace = undefined;
  calls.length = 0;
  handlers = next;
  inFlight = 0;
  maxInFlight = 0;
}

const settle = () => new Promise((done) => setTimeout(done, 0));

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A page with a virtual clock: each pause between reconcile commands is
 * recorded and advances the clock at once (yielding to the event loop).
 */
function mount(initialAttemptId?: string, mountOptions: { readonly settleMs?: number; readonly fromStore?: boolean; readonly principalId?: () => string } = {}) {
  let dispose!: () => void;
  const [attemptId, setAttemptId] = solid.createSignal<string | undefined>(initialAttemptId);
  const left: string[] = [];
  const pauses: number[] = [];
  const clock = { now: 0 };
  const attempt = solid.createRoot((disposeRoot: () => void) => {
    dispose = disposeRoot;
    return useInstallAttempt({
      get principalId() { return mountOptions.principalId?.() ?? "sub_me"; },
      attemptId,
      onStarted: (id: string) => setAttemptId(id),
      onLeft: (plan: { id: string }) => {
        left.push(plan.id);
        setAttemptId(undefined);
      },
      pacing: {
        now: () => clock.now,
        wait: (milliseconds: number) => {
          pauses.push(milliseconds);
          clock.now += milliseconds;
          return new Promise<void>((resolve) => setTimeout(resolve, 0));
        },
      },
      // Tests that confirm by hand never race the page's own confirmation.
      settleMs: mountOptions.settleMs ?? 60_000,
      fromStore: () => mountOptions.fromStore ?? false,
    });
  });
  return { attempt, dispose, attemptId, setAttemptId, left, pauses, clock };
}

/** A reconcile that only ends when the page aborts it. */
function abortable(signals: AbortSignal[]) {
  return (_id: never, init: never) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    if (signal) signals.push(signal);
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
}

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolveValue = ok; });
  return { promise, resolve: resolveValue };
}

const candidate = { url: URL_, ref: "", sourcePath: ".", modulePath: "" };

describe("install attempt controller", () => {
  test("opening a page with no attempt sends nothing", async () => {
    reset({});
    const page = mount();
    await settle();
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual([]);
    expect(page.attempt.view().stage).toBe("candidate");
    page.dispose();
  });

  test("reopening an attempt reads it once and does not advance it", async () => {
    reset({ getGitInstallPlan: async () => respond({ kind: "wait", phase: "syncing_source" }, 1) });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "paused", "paused");
    await new Promise((done) => setTimeout(done, 20));
    expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
    page.dispose();
  });

  const retainedReview: NonNullable<GitInstallPlanResponse["reviewSummary"]> = {
    modulePath: "deploy", appName: "office", environment: "integration",
    connections: [{ provider: requirement.provider, moduleLocalName: "cloudflare", connectionId: "conn_b", displayName: "B", autoSelected: null }],
    interfaces: [{ requirementKey: "chat", choice: { kind: "interface", interfaceId: "if_a" }, autoSelected: true }],
    settings: [
      { name: "domain", type: "string", required: true, sensitive: false, set: true, value: "office.example.test" },
      { name: "api_token", sensitive: true, set: true },
    ],
  };
  for (const phase of ["planning", "reviewable"] as const) {
    test(`a GET-only ${phase} reopen restores a read-only sheet without any mutation`, async () => {
      const action = phase === "planning" ? { kind: "wait", phase } as const : { kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" } as const;
      const retained = { ...inIntegration(respond(action, 7)), reviewSummary: retainedReview };
      reset({ getGitInstallPlan: async () => retained });
      const page = mount(ID, { settleMs: 5 });
      try {
        await until(() => page.attempt.response() !== undefined, "the retained attempt");
        expect(page.attempt.sheet()?.modulePath).toBe("deploy");
        expect(page.attempt.reviewSummary()).toEqual(retainedReview);
        expect(page.attempt.drafts()).toEqual({ domain: { value: "office.example.test", touched: true } });
        expect(page.attempt.drafts().api_token).toBeUndefined();
        expect(page.attempt.outdated()).toBe(false);
        await new Promise((done) => setTimeout(done, 30));
        expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
        expect(page.attempt.response()).toBe(retained);
      } finally { page.dispose(); }
    });
  }

  test("editing a reopened review replans with saved choices and public values but asks for secrets again", async () => {
    const SECOND = "gip_00000000000000b2";
    reset({
      getGitInstallPlan: async () => ({ ...inIntegration(respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 7)), reviewSummary: retainedReview }),
      discardGitInstallAttempt: async () => inIntegration(respond({ kind: "none" }, 8, "discarded")),
      createGitInstallAttempt: async () => inIntegration(respond(inputs({
        modulePath: "deploy", missing: [], connections: [{ ...requirement, selectedConnectionId: "conn_b" }],
        variables: [
          { name: "domain", type: "string", required: true, sensitive: false },
          { name: "api_token", type: "string", required: true, sensitive: true },
        ],
      }), 0, undefined, SECOND)),
    });
    const page = mount(ID, { settleMs: 5 });
    try {
      await until(() => page.attempt.view().stage === "review", "the review");
      expect(await page.attempt.editReviewSummary()).toBe(true);
      expect(page.attempt.response()?.installPlan.id).toBe(SECOND);
      expect(page.attempt.reviewSummary()).toBeUndefined();
      expect(page.attempt.drafts()).toEqual({ domain: { value: "office.example.test", touched: true } });
      const created = calls.find(({ name }) => name === "createGitInstallAttempt")?.args[1];
      expect(created).toMatchObject({
        capsule: { name: "office", environment: "integration" },
        options: {
          modulePath: "deploy",
          providerBindings: [{ provider: requirement.provider, moduleLocalName: "cloudflare", connectionId: "conn_b" }],
          interfaceLinks: [{ requirementKey: "chat", choice: { kind: "interface", interfaceId: "if_a" } }],
        },
      });
      expect(JSON.stringify(created)).not.toContain("office.example.test");
      await new Promise((done) => setTimeout(done, 30));
      expect(calls.filter(({ name }) => name === "answerGitInstallAttempt")).toEqual([]);
      expect(page.attempt.view().applyBlock).toBe("settings");
    } finally { page.dispose(); }
  });

  test("a replacement that fails before inputs never shows its predecessor's committed review", async () => {
    const SECOND = "gip_00000000000000b2";
    reset({
      getGitInstallPlan: async () => ({ ...respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 7), reviewSummary: retainedReview }),
      discardGitInstallAttempt: async () => respond({ kind: "none" }, 8, "discarded"),
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0, undefined, SECOND),
      reconcileGitInstallPlan: async () => respond({ kind: "retry", code: "source_sync_failed", restart: true }, 1, "failed", SECOND),
    });
    const page = mount(ID, { settleMs: 5 });
    try {
      await until(() => page.attempt.view().stage === "review", "the old review");
      expect(await page.attempt.editReviewSummary()).toBe(true);
      await until(() => page.attempt.response()?.installPlan.phase === "failed", "the replacement failure");
      expect(page.attempt.response()?.installPlan.id).toBe(SECOND);
      expect(page.attempt.reviewSummary()).toBeUndefined();
      expect(page.attempt.sheet()).toBeUndefined();
      expect(page.attempt.drafts().api_token).toBeUndefined();
      expect(calls.filter(({ name }) => name === "answerGitInstallAttempt")).toEqual([]);
    } finally { page.dispose(); }
  });

  test("editing a reopened integration Plan recreates it in integration", async () => {
    const SECOND = "gip_00000000000000b2";
    reset({
      getGitInstallPlan: async () => inIntegration(respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 7)),
      discardGitInstallAttempt: async () => inIntegration(respond({ kind: "none" }, 8, "discarded")),
      createGitInstallAttempt: async () => inIntegration(respond(inputs(), 0, undefined, SECOND)),
    });
    const page = mount(ID, { settleMs: 5 });
    try {
      await until(() => page.attempt.view().stage === "review", "the reopened integration Plan");
      page.attempt.changeVersion("v2.0.0");
      expect(page.attempt.outdated()).toBe(true);
      await until(() => page.attempt.response()?.installPlan.id === SECOND, "the replacement attempt");
      expect(calls.filter(({ name }) => name === "createGitInstallAttempt").map(({ args }) => args.slice(0, 2))).toEqual([
        ["ws_alpha", {
          mode: "attempt",
          source: { url: URL_, ref: "v2.0.0" },
          capsule: { name: "office", environment: "integration" },
        }],
      ]);
      expect(calls.filter(({ name }) => name === "discardGitInstallAttempt")).toHaveLength(1);
    } finally {
      page.dispose();
    }
  });

  for (const invalidated of [false, true]) {
    test(`Restart of a reopened ${invalidated ? "invalidated" : "failed"} integration attempt retains integration`, async () => {
      const SECOND = "gip_00000000000000b2";
      const failed = inIntegration(respond({ kind: "retry", code: invalidated ? "install_attempt_expired" : "source_sync_failed", restart: true }, 4, "failed"));
      reset({
        getGitInstallPlan: async () => invalidated ? { ...failed, invalidated: "install_attempt_expired" } : failed,
        discardGitInstallAttempt: async () => inIntegration(respond({ kind: "none" }, 5, "discarded")),
        createGitInstallAttempt: async () => inIntegration(respond(inputs(), 0, undefined, SECOND)),
      });
      const page = mount(ID);
      try {
        await until(() => page.attempt.view().primary === "restart", "Restart");
        expect(await page.attempt.restart()).toBe(true);
        expect(calls.filter(({ name }) => name === "createGitInstallAttempt").map(({ args }) => args.slice(0, 2))).toEqual([
          ["ws_alpha", {
            mode: "attempt",
            source: { url: URL_, ref: "HEAD" },
            capsule: { name: "office", environment: "integration" },
          }],
        ]);
        expect(page.attemptId()).toBe(SECOND);
      } finally {
        page.dispose();
      }
    });
  }

  test("an attempt opened without a workspace reads by explicit id", async () => {
    reset({ getGitInstallPlan: async () => respond(inputs(), 1) });
    setCurrentWorkspaceId("");
    try {
      const page = mount(ID);
      expect(page.attempt.view().stage).toBe("loading");
      await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
      expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
      page.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("an attempt missing at the scoped detail route is unavailable without a workspace", async () => {
    reset({ getGitInstallPlan: async () => { throw new api.ControlApiError(404, "not_found", "not found"); } });
    setCurrentWorkspaceId("");
    try {
      const page = mount(ID);
      await until(() => page.attempt.view().stage === "unavailable", "the refusal");
      expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
      page.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("Install starts one attempt and follows it to the sheet", async () => {
    let reconciles = 0;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: async () => {
        reconciles += 1;
        return reconciles === 1
          ? respond({ kind: "wait", phase: "analyzing_compatibility" }, 1)
          : respond(inputs(), 2);
      },
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    const starts = calls.filter(({ name }) => name === "createGitInstallAttempt");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.args.slice(0, 2)).toEqual(["ws_alpha", { mode: "attempt", source: { url: URL_ } }]);
    expect(page.attempt.latestSelected()).toBe(false);
    page.attempt.setVersionDraft("");
    page.attempt.commitVersion();
    expect(page.attempt.outdated()).toBe(false);
    expect(page.attemptId()).toBe(ID);
    expect(reconciles).toBe(2);
    expect(calls.some(({ name }) => /apply|approve/u.test(name))).toBe(false);
    page.dispose();
  });

  test("personal installs ignore a stale selected workspace and retain the retry key", async () => {
    let creates = 0;
    reset({
      createGitInstallAttempt: async () => {
        if (++creates === 1) throw new api.ControlApiError(503, "unavailable", "unavailable");
        return respond(inputs(), 0);
      },
    });
    personalOwnership = true;
    const page = mount();
    try {
      await page.attempt.start(candidate, { fromStore: false });
      setCurrentWorkspaceId("ws_stale_other");
      await settle();
      await page.attempt.start(candidate, { fromStore: false });
      expect(page.attempt.view().stage).toBe("provide_inputs");
      const starts = calls.filter(({ name }) => name === "createGitInstallAttempt");
      expect(starts).toHaveLength(2);
      expect(starts[0]!.args[0]).toBeUndefined();
      expect(starts[1]!.args).toEqual(starts[0]!.args);
    } finally {
      page.dispose();
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("an install cannot post after its workspace or URL changes during context discovery", async () => {
    for (const changed of ["workspace", "url"] as const) {
      reset({ getGitInstallPlan: async () => respond(inputs(), 0) });
      const discovery = deferred<string | undefined>();
      discoverInstallWorkspace = () => discovery.promise;
      const page = mount();
      try {
        const starting = page.attempt.start(candidate, { fromStore: false });
        await settle();
        if (changed === "workspace") setCurrentWorkspaceId("ws_other");
        else page.setAttemptId(ID);
        discovery.resolve("ws_alpha");
        await starting;
        expect(calls.some(({ name }) => name === "createGitInstallAttempt")).toBe(false);
      } finally {
        page.dispose();
        setCurrentWorkspaceId("ws_alpha");
      }
    }
  });

  test("an install cannot post after its legacy workspace changes while resolving a Store release", async () => {
    const resolution = deferred<{ tag: string; commit: string }>();
    reset({ resolveStableSourceTag: async () => await resolution.promise });
    const page = mount();
    try {
      const starting = page.attempt.start(candidate, { fromStore: true });
      await until(() => calls.some(({ name }) => name === "resolveStableSourceTag"), "source resolver");
      setCurrentWorkspaceId("ws_other");
      resolution.resolve({ tag: "v1.0.0", commit: "a".repeat(40) });
      await starting;
      expect(calls.some(({ name }) => name === "createGitInstallAttempt")).toBe(false);
    } finally {
      page.dispose();
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("personal attempts resume and replan despite a stale selected workspace", async () => {
    const second = "gip_00000000000000b2";
    reset({
      getGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 4),
      discardGitInstallAttempt: async () => respond({ kind: "none" }, 5, "discarded"),
      createGitInstallAttempt: async () => respond(inputs(), 0, undefined, second),
    });
    personalOwnership = true;
    setCurrentWorkspaceId("ws_stale_other");
    const page = mount(ID, { settleMs: 5 });
    try {
      await until(() => page.attempt.view().stage === "review", "personal review");
      setCurrentWorkspaceId("ws_stale_changed");
      page.attempt.changeVersion("v2.0.0");
      await until(() => page.attemptId() === second, "personal replacement");
      expect(page.left).toEqual([]);
      expect(calls.find(({ name }) => name === "createGitInstallAttempt")?.args[0]).toBeUndefined();
    } finally {
      page.dispose();
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("Install without a workspace starts directly and resumes by scoped attempt id", async () => {
    reset({
      createGitInstallAttempt: async () => withoutWorkspace(respond(inputs(), 0)),
      getGitInstallPlan: async () => withoutWorkspace(respond(inputs(), 0)),
    });
    setCurrentWorkspaceId("");
    try {
      const page = mount();
      await page.attempt.start(candidate, { fromStore: false });
      expect(page.attempt.view().stage).toBe("provide_inputs");
      expect(calls.filter(({ name }) => name === "createGitInstallAttempt").map(({ args }) => args[0])).toEqual([undefined]);
      expect(calls.some(({ name }) => name === "createWorkspace")).toBe(false);
      page.dispose();

      calls.length = 0;
      const reopened = mount(ID);
      await until(() => reopened.attempt.view().stage === "provide_inputs", "the reopened sheet");
      expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
      reopened.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("Restart without a workspace preserves the attempt and request authority", async () => {
    const second = "gip_00000000000000b2";
    reset({
      getGitInstallPlan: async () => withoutWorkspace(respond({ kind: "retry", code: "source_sync_failed", restart: true }, 4, "failed")),
      discardGitInstallAttempt: async () => withoutWorkspace(respond({ kind: "none" }, 5, "discarded")),
      createGitInstallAttempt: async () => withoutWorkspace(respond(inputs(), 0, undefined, second)),
    });
    setCurrentWorkspaceId("");
    try {
      const page = mount(ID);
      await until(() => page.attempt.view().primary === "restart", "Restart");
      expect(await page.attempt.restart()).toBe(true);
      expect(calls.filter(({ name }) => name === "createGitInstallAttempt").map(({ args }) => args[0])).toEqual([undefined]);
      expect(page.attemptId()).toBe(second);
      page.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("A changed Plan without a workspace prepares one replacement", async () => {
    const second = "gip_00000000000000b2";
    let creates = 0;
    reset({
      getGitInstallPlan: async () => withoutWorkspace(respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 4)),
      discardGitInstallAttempt: async () => withoutWorkspace(respond({ kind: "none" }, 5, "discarded")),
      createGitInstallAttempt: async () => {
        creates += 1;
        if (creates === 1) throw new api.ControlApiError(503, "unavailable", "unavailable");
        return withoutWorkspace(respond(inputs(), 0, undefined, second));
      },
    });
    setCurrentWorkspaceId("");
    try {
      const page = mount(ID, { settleMs: 5 });
      await until(() => page.attempt.view().stage === "review", "the review");
      page.attempt.changeVersion("v2.0.0");
      await until(() => page.attempt.view().progress === "replanPaused", "the unknown replacement outcome");
      page.attempt.resume();
      await until(() => page.attemptId() === second, "the replacement");
      const starts = calls.filter(({ name }) => name === "createGitInstallAttempt");
      expect(starts).toHaveLength(2);
      expect(starts[1]!.args).toEqual(starts[0]!.args);
      expect(starts[0]!.args[0]).toBeUndefined();
      expect(starts[0]!.args[1]).toMatchObject({ source: { ref: "v2.0.0" } });
      expect(calls.filter(({ name }) => name === "discardGitInstallAttempt")).toHaveLength(1);
      page.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("Store install without a workspace resolves the stable version before starting", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    reset({
      resolveStableSourceTag: async () => ({ tag: "v1.4.2", commit }),
      createGitInstallAttempt: async () => withoutWorkspace(withSourceRef(respond(inputs(), 0), commit)),
    });
    setCurrentWorkspaceId("");
    try {
      const page = mount();
      await page.attempt.start(candidate, { fromStore: true });
      expect(page.attempt.view().stage).toBe("provide_inputs");
      expect(calls.map(({ name }) => name)).toEqual(["resolveStableSourceTag", "createGitInstallAttempt"]);
      expect(calls[0]!.args).toEqual([undefined, URL_]);
      expect(calls[1]!.args[1]).toMatchObject({ source: { ref: commit } });
      expect(page.attempt.latestSelected()).toBe(true);
      expect(page.attempt.resolvedVersion()).toEqual({ tag: "v1.4.2", commit });
      page.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("only a missing account stable resolver asks for an explicit version", async () => {
    const { t } = await import(resolve(dashboard, "src/i18n/index.ts"));
    setCurrentWorkspaceId("");
    try {
      for (const status of [404, 503]) {
        reset({ resolveStableSourceTag: async () => { throw new api.ControlApiError(status, status === 404 ? "route_not_found" : "unavailable", "unavailable"); } });
        const page = mount();
        await page.attempt.start(candidate, { fromStore: true });
        expect(page.attempt.view().stage).toBe("candidate");
        expect(calls.map(({ name }) => name)).toEqual(["resolveStableSourceTag"]);
        expect(page.attempt.error() === t("installStore.error.sourceRefRequired")).toBe(status === 404);
        page.dispose();
      }
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("a Store Plan without a workspace resolves an emptied version before preparing again", async () => {
    const second = "gip_00000000000000b2";
    const commit = "abcdef0123456789abcdef0123456789abcdef01";
    reset({
      getGitInstallPlan: async () => {
        const current = withoutWorkspace(respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 4));
        return { ...current, installPlan: { ...current.installPlan, source: { ...current.installPlan.source, ref: "old-release" } } };
      },
      resolveStableSourceTag: async () => ({ tag: "v2.0.0", commit }),
      discardGitInstallAttempt: async () => withoutWorkspace(respond({ kind: "none" }, 5, "discarded")),
      createGitInstallAttempt: async () => withoutWorkspace(respond(inputs(), 0, undefined, second)),
    });
    setCurrentWorkspaceId("");
    try {
      const page = mount(ID, { settleMs: 5, fromStore: true });
      await until(() => page.attempt.view().stage === "review", "the review");
      page.attempt.changeVersion("");
      await until(() => page.attemptId() === second, "the replacement");
      expect(calls.map(({ name }) => name)).toEqual([
        "getGitInstallPlan", "resolveStableSourceTag", "discardGitInstallAttempt", "createGitInstallAttempt",
      ]);
      expect(calls.find(({ name }) => name === "resolveStableSourceTag")?.args).toEqual([undefined, URL_]);
      expect(calls.find(({ name }) => name === "createGitInstallAttempt")?.args[1]).toMatchObject({ source: { ref: commit } });
      page.dispose();
    } finally {
      setCurrentWorkspaceId("ws_alpha");
    }
  });

  test("setting values travel only in the confirming answer", async () => {
    let generation = 2;
    reset({
      getGitInstallPlan: async () => respond(inputs(), generation),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        const answer = body as Record<string, unknown>;
        generation += 1;
        if (answer.continue) return respond({ kind: "wait", phase: "planning" }, generation);
        if (answer.capsuleName) {
          return respond(inputs({
            connections: [{ ...requirement, selectedConnectionId: "conn_b" }],
            missing: [],
            name: { current: answer.capsuleName, proposed: answer.capsuleName, conflict: false },
          }), generation);
        }
        return respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_b" }], missing: [] }), generation);
      },
      reconcileGitInstallPlan: async () =>
        respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, generation + 1),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    await page.attempt.chooseConnection(requirement, "conn_b");
    page.attempt.setDraft("api_token", SECRET);
    page.attempt.setNameDraft("office-two");
    await page.attempt.saveName();
    expect(page.attempt.view()).toMatchObject({ primary: "review", primaryBlocked: false });
    await page.attempt.confirm();
    await until(() => page.attempt.view().stage === "review", "the review");

    const answers = calls.filter(({ name }) => name === "answerGitInstallAttempt");
    expect(answers.map(({ args }) => args[1])).toEqual([
      { expectedGeneration: 2, providerBindings: [{ provider: requirement.provider, moduleLocalName: "cloudflare", connectionId: "conn_b" }] },
      { expectedGeneration: 3, capsuleName: "office-two" },
      { expectedGeneration: 4, continue: true, variables: { api_token: SECRET } },
    ]);
    const elsewhere = calls.filter((call) => call !== answers[2]);
    expect(JSON.stringify(elsewhere)).not.toContain(SECRET);
    // The values stay in this page's memory only, so a change after the Plan
    // can send them again, and are gone once the install is done.
    expect(page.attempt.drafts()).toEqual({ api_token: { value: SECRET, touched: true } });
    page.attempt.finish();
    expect(page.attempt.drafts()).toEqual({});
    page.dispose();
  });

  test("an unconfirmed confirmation keeps the values to send the same ones again", async () => {
    let generation = 5;
    let continues = 0;
    const interfaces = [{ ...linkedRequirement, candidates: [linkedRequirement.candidates[0]!], choice: { kind: "interface" as const, interfaceId: "if_a" }, autoSelected: true }];
    reset({
      getGitInstallPlan: async () =>
        continues === 0
          ? respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_a", autoSelected: true }], interfaces, missing: [] }), generation)
          : respond(inputs({ connections: [], interfaces, missing: [], resubmitVariables: ["api_token"] }), generation),
      answerGitInstallAttempt: async () => {
        continues += 1;
        if (continues === 1) throw new api.ControlApiError(503, "unavailable", "unavailable");
        generation += 1;
        return respond({ kind: "wait", phase: "planning" }, generation);
      },
      reconcileGitInstallPlan: async () => respond({ kind: "wait", phase: "planning" }, generation),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setDraft("api_token", SECRET);
    await page.attempt.confirm();
    expect(page.attempt.error()).toBeTruthy();
    expect(page.attempt.drafts().api_token?.value).toBe(SECRET);
    await page.attempt.confirm();
    const sent = calls.filter(({ name }) => name === "answerGitInstallAttempt").map(({ args }) => args[1]);
    expect(sent).toEqual([
      { expectedGeneration: 5, continue: true, observedInterfaces: [{ requirementKey: "chat", candidateIds: ["if_a"] }], variables: { api_token: SECRET } },
      { expectedGeneration: 5, continue: true, variables: { api_token: SECRET } },
    ]);
    await page.attempt.discard().catch(() => false);
    page.dispose();
  });

  test("a stale answer shows the attempt as the server holds it now", async () => {
    let reads = 0;
    reset({
      getGitInstallPlan: async () => {
        reads += 1;
        return respond(inputs(), reads === 1 ? 2 : 7);
      },
      answerGitInstallAttempt: async () => {
        throw new api.ControlApiError(409, "install_plan_generation_conflict", "changed");
      },
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    await page.attempt.chooseConnection(requirement, "conn_a");
    expect(page.attempt.response()?.installPlan.generation).toBe(7);
    expect(page.attempt.error()).toBeTruthy();
    page.dispose();
  });

  test("Stop installing aborts the reconcile in flight, then discards with the latest generation", async () => {
    const signals: AbortSignal[] = [];
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: abortable(signals),
      getGitInstallPlan: async () => respond({ kind: "wait", phase: "compiling_install" }, 2),
      discardGitInstallAttempt: async (_id: never, generation: never) => {
        if ((generation as number) !== 2) {
          throw new api.ControlApiError(409, "install_plan_generation_conflict", "changed");
        }
        return respond({ kind: "none" }, 3, "discarded");
      },
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => signals.length === 1, "the first reconcile");
    expect(await page.attempt.discard()).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
    // The aborted command may have moved the attempt on: the stale
    // generation is read again before the discard that succeeds.
    expect(calls.filter(({ name }) => name === "discardGitInstallAttempt").map(({ args }) => args)).toEqual([[ID, 0], [ID, 2]]);
    expect(maxInFlight).toBe(1);
    expect(page.left).toEqual([ID]);
    expect(page.attempt.view().stage).toBe("candidate");
    page.dispose();
  });

  test("a command still holding the attempt is waited out for a bounded time, then named as still processing", async () => {
    reset({
      getGitInstallPlan: async () => respond(inputs(), 1),
      discardGitInstallAttempt: async () => {
        throw new api.ControlApiError(409, "reconcile_in_progress", "busy");
      },
    });
    const { t } = await import(resolve(dashboard, "src/i18n/index.ts"));
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    expect(await page.attempt.discard()).toBe(false);
    // About fifteen seconds in all, growing between tries; never unbounded.
    expect(page.pauses).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
    expect(calls.filter(({ name }) => name === "discardGitInstallAttempt")).toHaveLength(6);
    expect(page.attempt.error()).toBe(t("installStore.error.stillProcessing"));
    expect(page.attempt.error()).not.toBe(t("installStore.error.changed"));
    expect(page.left).toEqual([]);
    page.dispose();
  });

  test("a lease released during the wait lets the discard go through", async () => {
    let refusals = 2;
    reset({
      getGitInstallPlan: async () => respond(inputs(), 1),
      discardGitInstallAttempt: async () => {
        if (refusals-- > 0) throw new api.ControlApiError(409, "reconcile_in_progress", "busy");
        return respond({ kind: "none" }, 2, "discarded");
      },
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    expect(await page.attempt.discard()).toBe(true);
    expect(page.pauses).toEqual([1_000, 2_000]);
    expect(page.left).toEqual([ID]);
    page.dispose();
  });

  test("Try again on a retryable step sends reconcile and keeps following", async () => {
    let reconciles = 0;
    reset({
      getGitInstallPlan: async () =>
        respond({ kind: "retry", code: "install_plan_reconcile_retryable", restart: false }, 4, "planning"),
      reconcileGitInstallPlan: async () => {
        reconciles += 1;
        return reconciles === 1
          ? respond({ kind: "wait", phase: "planning" }, 5, "planning")
          : respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 6);
      },
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "retry", "the retry stage");
    expect(page.attempt.view()).toMatchObject({ primary: "retry", primaryBlocked: false });
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review", "the review");
    expect(reconciles).toBe(2);
    page.dispose();
  });

  test("a step that stays retryable stops after a few tries and offers Try again", async () => {
    reset({
      getGitInstallPlan: async () =>
        respond({ kind: "retry", code: "install_plan_reconcile_retryable", restart: false }, 4, "planning"),
      reconcileGitInstallPlan: async () =>
        respond({ kind: "retry", code: "install_plan_reconcile_retryable", restart: false }, 4, "planning"),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "retry", "the retry stage");
    page.attempt.resume();
    await until(() => !page.attempt.driving() && calls.some(({ name }) => name === "reconcileGitInstallPlan"), "the page to stop");
    expect(calls.filter(({ name }) => name === "reconcileGitInstallPlan")).toHaveLength(3);
    expect(page.attempt.view().stage).toBe("retry");
    page.dispose();
  });

  test("a lost reconcile response waits out a peer lease on reads of the same attempt", async () => {
    let writes = 0;
    let reads = 0;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: async () => {
        writes += 1;
        if (writes === 1) throw new api.ControlApiError(502, undefined, "upstream closed");
        if (writes === 2) throw new api.ControlApiError(409, "reconcile_in_progress", "lease held", {
          error: { details: { retryAfterMs: 30_000 } },
        });
        expect(reads).toBe(7);
        return respond(inputs(), 2);
      },
      getGitInstallPlan: async () => {
        reads += 1;
        // Only the settlement changes phase, in the same claimed generation.
        const phase = reads === 7 ? "compiling_install" : "syncing_source";
        return respond({ kind: "wait", phase }, 1);
      },
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => !page.attempt.driving(), "finishing the attempt follow");
    expect(page.attempt.view().stage).toBe("provide_inputs");
    expect(writes).toBe(3);
    expect(reads).toBe(7);
    expect(calls.filter(({ name }) => name === "createGitInstallAttempt")).toHaveLength(1);
    expect(calls.filter(({ name }) => name === "reconcileGitInstallPlan").map(({ args }) => args[0]))
      .toEqual([ID, ID, ID]);
    expect(page.attempt.error()).toBeUndefined();
    page.dispose();
  });

  test("observing the completed phase clears the failure streak after a lost response", async () => {
    let writes = 0;
    const phases = ["compiling_install", "analyzing_compatibility", "creating_capsule"] as const;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: async () => {
        writes += 1;
        if (writes <= phases.length) throw new api.ControlApiError(502, undefined, "upstream closed");
        return respond(inputs(), writes);
      },
      getGitInstallPlan: async () => respond({ kind: "wait", phase: phases[writes - 1]! }, writes),
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => !page.attempt.driving(), "finishing the attempt follow");
    expect(page.attempt.view().stage).toBe("provide_inputs");
    expect(writes).toBe(4);
    expect(page.attempt.error()).toBeUndefined();
    page.dispose();
  });

  test("a held attempt with no visible settlement can be reconciled after the busy wait", async () => {
    let writes = 0;
    let reads = 0;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: async () => {
        writes += 1;
        if (writes === 1) throw new api.ControlApiError(409, "reconcile_in_progress", "lease held", {
          error: { details: { retryAfterMs: 30_000 } },
        });
        expect(reads).toBeGreaterThan(3);
        return respond(inputs(), 2);
      },
      getGitInstallPlan: async () => {
        reads += 1;
        return respond({ kind: "wait", phase: "syncing_source" }, 1);
      },
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => !page.attempt.driving(), "ending the busy wait");
    expect(page.attempt.view().stage).toBe("provide_inputs");
    expect(writes).toBe(2);
    expect(page.clock.now).toBeGreaterThanOrEqual(30_000);
    expect(page.clock.now).toBeLessThan(120_000);
    page.dispose();
  });

  test("a coordinator that only waits is followed with a growing pause and then left to Continue", async () => {
    const random = Math.random;
    Math.random = () => 1;
    try {
      let generation = 1;
      reset({
        getGitInstallPlan: async () => respond({ kind: "wait", phase: "planning" }, generation, "planning"),
        // Every successful claim bumps the generation, with nothing else new.
        reconcileGitInstallPlan: async () => {
          generation += 1;
          return respond({ kind: "wait", phase: "planning" }, generation, "planning");
        },
      });
      const page = mount(ID);
      await until(() => page.attempt.view().stage === "paused", "the paused stage");
      page.attempt.resume();
      await until(() => page.attempt.driving(), "following");
      await until(() => !page.attempt.driving(), "the stall limit");
      const reconciles = calls.filter(({ name }) => name === "reconcileGitInstallPlan").length;
      // 250 + 500 + 1000 + 2000 ms, then the 3 s ceiling until two quiet
      // minutes have passed: 43 commands, not four a second forever.
      expect(page.pauses.slice(0, 6)).toEqual([250, 500, 1000, 2000, 3000, 3000]);
      expect(Math.max(...page.pauses)).toBe(3000);
      expect(reconciles).toBe(43);
      expect(page.clock.now).toBeGreaterThanOrEqual(120_000);
      expect(page.attempt.view()).toMatchObject({ stage: "paused", primary: "continue" });
      page.dispose();
    } finally {
      Math.random = random;
    }
  });

  test("a coordinator that keeps moving is followed at the shortest pause", async () => {
    const random = Math.random;
    Math.random = () => 1;
    try {
      const phases = ["compiling_install", "analyzing_compatibility", "creating_capsule", "planning"] as const;
      let round = 0;
      reset({
        createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
        reconcileGitInstallPlan: async () => {
          round += 1;
          const phase = phases[round - 1];
          return phase
            ? respond({ kind: "wait", phase }, round, phase)
            : respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, round);
        },
      });
      const page = mount();
      await page.attempt.start(candidate, { fromStore: false });
      await until(() => page.attempt.view().stage === "review", "the review");
      expect(page.pauses).toEqual([250, 250, 250, 250]);
      page.dispose();
    } finally {
      Math.random = random;
    }
  });

  test("while the URL's attempt loads, Install starts nothing", async () => {
    const gate = deferred<GitInstallPlanResponse>();
    reset({ getGitInstallPlan: () => gate.promise });
    const page = mount(ID);
    await settle();
    expect(page.attempt.view()).toMatchObject({ stage: "loading", primary: "none" });
    await page.attempt.start(candidate, { fromStore: false });
    expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
    gate.resolve(respond({ kind: "wait", phase: "syncing_source" }, 3));
    await until(() => page.attempt.view().stage === "paused", "the reopened attempt");
    expect(page.attempt.response()?.installPlan.id).toBe(ID);
    page.dispose();
  });

  test("a slow read never overwrites a newer answer", async () => {
    let reads = 0;
    const slow = deferred<GitInstallPlanResponse>();
    reset({
      getGitInstallPlan: async () => {
        reads += 1;
        return reads === 1 ? respond(inputs(), 2) : slow.promise;
      },
      answerGitInstallAttempt: async () =>
        respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_a" }], missing: [] }), 3),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    const reading = page.attempt.reload();
    await page.attempt.chooseConnection(requirement, "conn_a");
    expect(page.attempt.response()?.installPlan.generation).toBe(3);
    slow.resolve(respond(inputs(), 2));
    await reading;
    expect(page.attempt.response()?.installPlan.generation).toBe(3);
    page.dispose();
  });

  test("values typed for a confirmation whose answer was lost stay in memory only until the install ends", async () => {
    let confirmed = false;
    reset({
      getGitInstallPlan: async () =>
        confirmed
          ? respond({ kind: "wait", phase: "planning" }, 7, "planning")
          : respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_a", autoSelected: true }], missing: [] }), 5),
      answerGitInstallAttempt: async () => {
        confirmed = true;
        throw new api.ControlApiError(503, "unavailable", "unavailable");
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 8),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setDraft("api_token", SECRET);
    await page.attempt.confirm();
    expect(page.attempt.view().stage).not.toBe("provide_inputs");
    expect(page.attempt.drafts()).toEqual({ api_token: { value: SECRET, touched: true } });
    page.attempt.finish();
    expect(page.attempt.drafts()).toEqual({});
    page.dispose();
  });

  test("Review right after editing the name waits for the rename instead of losing the click", async () => {
    const rename = deferred<GitInstallPlanResponse>();
    let generation = 2;
    reset({
      getGitInstallPlan: async () =>
        respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_a", autoSelected: true }], missing: [] }), generation),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        const answer = body as Record<string, unknown>;
        if (answer.capsuleName) {
          const next = await rename.promise;
          generation = next.installPlan.generation;
          return next;
        }
        generation += 1;
        return respond({ kind: "wait", phase: "planning" }, generation, "planning");
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, generation + 1),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setDraft("api_token", SECRET);
    page.attempt.setNameDraft("office-two");
    const leaving = page.attempt.saveName();
    await settle();
    // The Review button stays pressable while the rename is in flight.
    expect(page.attempt.view()).toMatchObject({ primary: "review", primaryBlocked: false });
    const reviewing = page.attempt.confirm();
    rename.resolve(respond(inputs({
      connections: [{ ...requirement, selectedConnectionId: "conn_a", autoSelected: true }],
      missing: [],
      name: { current: "office-two", proposed: "office-two", conflict: false },
    }), 3));
    await leaving;
    await reviewing;
    await until(() => page.attempt.view().stage === "review", "the review");
    expect(calls.filter(({ name }) => name === "answerGitInstallAttempt").map(({ args }) => args[1])).toEqual([
      { expectedGeneration: 2, capsuleName: "office-two" },
      { expectedGeneration: 3, continue: true, variables: { api_token: SECRET } },
    ]);
    page.dispose();
  });

  test("a name typed while a rename is in flight is the one Review sends", async () => {
    const first = deferred<GitInstallPlanResponse>();
    let generation = 2;
    const sheet = (name: string) => respond(inputs({
      connections: [{ ...requirement, selectedConnectionId: "conn_a", autoSelected: true }],
      missing: [],
      variables: [],
      name: { current: name, proposed: name, conflict: false },
    }), generation);
    reset({
      getGitInstallPlan: async () => sheet("office"),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        const answer = body as Record<string, unknown>;
        if (answer.continue) {
          generation += 1;
          return respond({ kind: "wait", phase: "planning" }, generation, "planning");
        }
        const next = await first.promise;
        generation = next.installPlan.generation;
        return next;
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, generation + 1),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setNameDraft("office-2");
    const renaming = page.attempt.saveName();
    await settle();
    page.attempt.setNameDraft("office-final");
    const reviewing = page.attempt.confirm();
    generation = 3;
    first.resolve(sheet("office-2"));
    await renaming;
    await reviewing;
    expect(calls.filter(({ name }) => name === "answerGitInstallAttempt").map(({ args }) => args[1])).toEqual([
      { expectedGeneration: 2, capsuleName: "office-2" },
      { expectedGeneration: 3, continue: true, capsuleName: "office-final" },
    ]);
    page.dispose();
  });

  test("a Store listing installs the newest released version unless one was chosen", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    reset({
      resolveStableSourceTag: async () => ({ tag: "v1.4.2", commit }),
      createGitInstallAttempt: async () => withSourceRef(respond({ kind: "wait", phase: "syncing_source" }, 0), commit),
      reconcileGitInstallPlan: async () => withSourceRef(respond(inputs(), 1), commit),
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: true });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    const start = calls.find(({ name }) => name === "createGitInstallAttempt");
    expect(start?.args[1]).toEqual({ mode: "attempt", source: { url: URL_, ref: commit } });
    expect(page.attempt.latestSelected()).toBe(true);
    expect(page.attempt.resolvedVersion()).toEqual({ tag: "v1.4.2", commit });
    page.attempt.setVersionDraft("");
    page.attempt.commitVersion();
    expect(page.attempt.outdated()).toBe(false);
    expect(page.attempt.refDraft()).toBeUndefined();
    page.dispose();
  });

  test("opening a different Store attempt at the same commit does not inherit Latest", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const other = "gip_00000000000000b2";
    reset({
      resolveStableSourceTag: async () => ({ tag: "v1.4.2", commit }),
      createGitInstallAttempt: async () => withSourceRef(respond(inputs(), 0), commit),
      getGitInstallPlan: async () => withSourceRef(respond(inputs(), 0, undefined, other), commit),
    });
    const page = mount(undefined, { fromStore: true });
    try {
      await page.attempt.start(candidate, { fromStore: true });
      expect(page.attempt.latestSelected()).toBe(true);
      calls.length = 0;
      page.setAttemptId(other);
      await until(() => page.attempt.response()?.installPlan.id === other, "the other attempt");
      expect(page.attempt.latestSelected()).toBe(false);
      expect(page.attempt.resolvedVersion()).toBeUndefined();
      expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
    } finally {
      page.dispose();
    }
  });
  // --- Two decisions: the Plan is made on its own ---------------------------

  const ready = () => inputs({
    connections: [{ ...requirement, candidates: [requirement.candidates[0]], selectedConnectionId: "conn_a", autoSelected: true }],
    variables: [],
    missing: [],
  });
  const answerBodies = () =>
    calls.filter(({ name }) => name === "answerGitInstallAttempt").map(({ args }) => args[1] as Record<string, unknown>);
  const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

  test("a complete sheet is confirmed on its own once edits settle, and only once", async () => {
    let generation = 0;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, generation),
      reconcileGitInstallPlan: async () => {
        generation += 1;
        return generation === 1
          ? respond(ready(), generation)
          : respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, generation);
      },
      answerGitInstallAttempt: async () => {
        generation += 1;
        return respond({ kind: "wait", phase: "planning" }, generation);
      },
    });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the Plan");
    await pause(30);
    expect(answerBodies()).toEqual([{ expectedGeneration: 1, continue: true }]);
    // Making the Plan never applies it.
    expect(calls.some(({ name }) => /apply|approve/u.test(name))).toBe(false);
    expect(page.attempt.view().applyBlock).toBeUndefined();
    page.dispose();
  });

  test("nothing is confirmed while a connection or a required setting is missing", async () => {
    let generation = 4;
    const sheet = (selected: boolean) => inputs({
      connections: [selected ? { ...requirement, selectedConnectionId: "conn_b" } : requirement],
      missing: selected ? [] : ["connections"],
    });
    reset({
      getGitInstallPlan: async () => respond(sheet(false), generation),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        generation += 1;
        return (body as { continue?: boolean }).continue
          ? respond({ kind: "wait", phase: "planning" }, generation)
          : respond(sheet(true), generation);
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, generation + 1),
    });
    const page = mount(ID, { settleMs: 5 });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.resume();
    await pause(30);
    expect(page.attempt.view().applyBlock).toBe("connections");
    await page.attempt.chooseConnection(requirement, "conn_b");
    await pause(30);
    // The connection is there; the required secret is not.
    expect(page.attempt.view().applyBlock).toBe("settings");
    expect(answerBodies().filter((body) => body.continue)).toEqual([]);
    page.attempt.setDraft("api_token", SECRET);
    await until(() => page.attempt.view().stage === "review", "the Plan");
    expect(answerBodies().filter((body) => body.continue)).toEqual([
      { expectedGeneration: 5, continue: true, variables: { api_token: SECRET } },
    ]);
    page.dispose();
  });

  test("a reopened complete sheet is only read until the person continues", async () => {
    reset({
      getGitInstallPlan: async () => respond(ready(), 3),
      answerGitInstallAttempt: async () => respond({ kind: "wait", phase: "planning" }, 4),
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 5),
    });
    const page = mount(ID, { settleMs: 5 });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    await pause(30);
    expect(calls.map(({ name }) => name)).toEqual(["getGitInstallPlan"]);
    expect(page.attempt.view()).toMatchObject({ applyBlock: "paused", progress: "paused" });
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review", "the Plan");
    expect(answerBodies()).toEqual([{ expectedGeneration: 3, continue: true }]);
    page.dispose();
  });

  test("a confirmation that did not go through is not sent again on its own", async () => {
    let refuse = true;
    reset({
      getGitInstallPlan: async () => respond(ready(), 3),
      answerGitInstallAttempt: async () => {
        if (refuse) throw new api.ControlApiError(409, "install_inputs_incomplete", "incomplete", "provider_connection_required");
        return respond({ kind: "wait", phase: "planning" }, 4);
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 5),
    });
    const page = mount(ID, { settleMs: 5 });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.resume();
    await until(() => answerBodies().length === 1, "the first confirmation");
    await pause(40);
    expect(answerBodies()).toHaveLength(1);
    expect(page.attempt.error()).toBeTruthy();
    expect(page.attempt.view().applyBlock).toBe("paused");
    refuse = false;
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review", "the Plan");
    expect(answerBodies()).toHaveLength(2);
    page.dispose();
  });

  test("saved-review holds pause answers and replanning without changing permanent-lock discard semantics", async () => {
    const sheet = () => inputs({ connections: [], missing: [], variables: [{ name: "domain", type: "string", required: false, sensitive: false }] });
    reset({
      getGitInstallPlan: async () => respond(sheet(), 3),
      answerGitInstallAttempt: async () => respond({ kind: "wait", phase: "planning" }, 4),
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 5),
      discardGitInstallAttempt: async () => respond({ kind: "none" }, 6, "discarded"),
    });
    const page = mount(ID, { settleMs: 5 });
    try {
      await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
      const first = page.attempt.holdReview();
      const second = page.attempt.holdReview();
      page.attempt.resume();
      await page.attempt.confirm();
      page.attempt.setDraft("domain", "blocked.example.test");
      await pause(30);
      expect(page.attempt.drafts()).toEqual({});
      expect(answerBodies()).toEqual([]);
      expect(await page.attempt.discard()).toBe(false);
      expect(await page.attempt.restart()).toBe(false);
      first(); first();
      expect(page.attempt.locked()).toBe(true);
      expect(page.attempt.view().canDiscard).toBe(false);
      second();
      page.attempt.resume();
      await until(() => page.attempt.view().stage === "review", "the unheld confirmation");
      expect(answerBodies()).toEqual([{ expectedGeneration: 3, continue: true }]);
      expect(page.attempt.locked()).toBe(false);
      page.attempt.setDraft("domain", "changed.example.test");
      page.attempt.commitDraft("domain");
      const pending = page.attempt.holdReview();
      await pause(30);
      expect(calls.filter(({ name }) => name === "discardGitInstallAttempt")).toEqual([]);
      expect(await page.attempt.restart()).toBe(false);
      expect(await page.attempt.discard()).toBe(false);
      // Releasing a read hold cannot undo the permanent lock established by Apply.
      page.attempt.lockAnswers(); pending();
      expect(page.attempt.locked()).toBe(true);
      // That old lock alone never prohibited a definitive-rejection Stop.
      expect(page.attempt.view().canDiscard).toBe(true);
      expect(await page.attempt.discard()).toBe(true);
      expect(calls.filter(({ name }) => name === "discardGitInstallAttempt")).toHaveLength(1);
    } finally { page.dispose(); }
  });

  test("a change after the Plan prepares the install again once, with the same answers", async () => {
    const SECOND = "gip_00000000000000b2";
    let creates = 0;
    const generations: Record<string, number> = { [ID]: 0, [SECOND]: 0 };
    const id = () => (creates === 1 ? ID : SECOND);
    const settingSheet = () => inputs({
      connections: [{ ...requirement, selectedConnectionId: "conn_b" }],
      variables: [{ name: "domain", type: "string", required: false, sensitive: false }],
      missing: [],
      modulePath: "deploy",
    });
    reset({
      createGitInstallAttempt: async () => {
        creates += 1;
        return respond({ kind: "wait", phase: "syncing_source" }, 0, undefined, id());
      },
      reconcileGitInstallPlan: async (attemptId: never) => {
        const current = attemptId as unknown as string;
        generations[current] = (generations[current] ?? 0) + 1;
        const generation = generations[current]!;
        return generation === 1
          ? respond(settingSheet(), generation, undefined, current)
          : respond({ kind: "review_run", planRunId: `run_${current}`, capsuleId: "cap_office" }, generation, undefined, current);
      },
      answerGitInstallAttempt: async (attemptId: never) => {
        const current = attemptId as unknown as string;
        generations[current] = (generations[current] ?? 0) + 1;
        return respond({ kind: "wait", phase: "planning" }, generations[current]!, undefined, current);
      },
      getGitInstallPlan: async (attemptId: never) => {
        const current = attemptId as unknown as string;
        return respond({ kind: "review_run", planRunId: `run_${current}`, capsuleId: "cap_office" }, generations[current]!, undefined, current);
      },
      discardGitInstallAttempt: async (attemptId: never) => {
        const current = attemptId as unknown as string;
        generations[current] = (generations[current] ?? 0) + 1;
        return respond({ kind: "none" }, generations[current]!, "discarded", current);
      },
    });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the first Plan");
    page.attempt.setDraft("domain", "apps.example.com");
    // The shown Plan is out of date at once: it can no longer be applied.
    expect(page.attempt.outdated()).toBe(true);
    expect(page.attempt.view().applyBlock).toBe("replanning");
    await until(() => page.attempt.view().stage === "review" && page.attempt.response()?.installPlan.id === SECOND, "the new Plan");
    await pause(40);

    expect(calls.filter(({ name }) => name === "discardGitInstallAttempt").map(({ args }) => args[0])).toEqual([ID]);
    const created = calls.filter(({ name }) => name === "createGitInstallAttempt").map(({ args }) => args[1]);
    // The same repository (its default version), with the name, module and
    // connection the person had.
    expect(created).toEqual([
      { mode: "attempt", source: { url: URL_ } },
      {
        mode: "attempt",
        source: { url: URL_ },
        capsule: { name: "office", environment: "production" },
        options: { modulePath: "deploy", providerBindings: [{ provider: requirement.provider, moduleLocalName: "cloudflare", connectionId: "conn_b" }] },
      },
    ]);
    // Values go only with each attempt's confirmation, never with a create.
    expect(answerBodies()).toEqual([
      { expectedGeneration: 1, continue: true },
      { expectedGeneration: 1, continue: true, variables: { domain: "apps.example.com" } },
    ]);
    expect(JSON.stringify(created)).not.toContain("apps.example.com");
    expect(page.attemptId()).toBe(SECOND);
    expect(page.attempt.view().applyBlock).toBeUndefined();
    expect(calls.some(({ name }) => /apply|approve/u.test(name))).toBe(false);
    page.dispose();
  });
  test("once an Apply started, nothing on the screen changes what is installed", async () => {
    let generation = 0;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, generation),
      reconcileGitInstallPlan: async () => {
        generation += 1;
        return generation === 1
          ? respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_b" }], variables: [{ name: "domain", type: "string", required: false, sensitive: false }], missing: [] }), generation)
          : respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, generation);
      },
      answerGitInstallAttempt: async () => {
        generation += 1;
        return respond({ kind: "wait", phase: "planning" }, generation);
      },
    });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    page.attempt.setDraft("domain", "kept.example.com");
    await until(() => page.attempt.view().stage === "review", "the Plan");
    page.attempt.lockAnswers();
    page.attempt.setDraft("domain", "late.example.com");
    page.attempt.setNameDraft("late-name");
    expect(await page.attempt.chooseConnection(requirement, "conn_a")).toBe(false);
    page.attempt.changeVersion("v9.9.9");
    await pause(40);
    expect(page.attempt.outdated()).toBe(false);
    expect(page.attempt.drafts()).toEqual({ domain: { value: "kept.example.com", touched: true } });
    expect(page.attempt.nameDraft()).toBeUndefined();
    expect(calls.filter(({ name }) => name === "discardGitInstallAttempt" || name === "createGitInstallAttempt")).toHaveLength(1);
    page.dispose();
  });
  // --- Review findings: lost answers, failures while preparing again --------

  /**
   * A coordinator with several attempts (one per create) that the tests can
   * make refuse a discard, fail a start, lose a confirmation's answer after
   * committing it, or fail the Plan.
   */
  function coordinator(config: {
    readonly sheet: () => GitInstallPlanUserAction;
    readonly refuseDiscard?: () => boolean;
    readonly failCreate?: (count: number) => boolean;
    readonly loseContinue?: () => boolean;
    readonly planFails?: () => boolean;
  }) {
    const ids = [ID, "gip_00000000000000b2", "gip_00000000000000b3", "gip_00000000000000b4"];
    const attempts = new Map<string, { generation: number; phase: string; action: GitInstallPlanUserAction; ref: string; interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] }>();
    let creates = 0;
    const read = (id: string) => {
      const attempt = attempts.get(id)!;
      const response = withSourceRef(respond(attempt.action, attempt.generation, attempt.phase, id), attempt.ref);
      return { ...response, installPlan: { ...response.installPlan, options: { ...(attempt.interfaceLinks !== undefined ? { interfaceLinks: attempt.interfaceLinks } : {}) } } };
    };
    const handlers = {
      createGitInstallAttempt: async (_workspaceId?: never, request?: never) => {
        creates += 1;
        if (config.failCreate?.(creates)) throw new api.ControlApiError(503, "unavailable", "unavailable");
        const id = ids[attempts.size]!;
        const body = request as { source?: { ref?: string }; options?: { interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] } } | undefined;
        const links = body?.options?.interfaceLinks;
        attempts.set(id, { generation: 0, phase: "syncing_source", action: { kind: "wait", phase: "syncing_source" }, ref: body?.source?.ref ?? "HEAD", ...(links !== undefined ? { interfaceLinks: links } : {}) });
        return read(id);
      },
      reconcileGitInstallPlan: async (id: never) => {
        const attempt = attempts.get(id as unknown as string)!;
        attempt.generation += 1;
        if (attempt.phase === "syncing_source") {
          attempt.phase = "awaiting_input";
          attempt.action = config.sheet();
          if (attempt.action.kind === "provide_inputs" && attempt.interfaceLinks !== undefined) {
            attempt.action = { ...attempt.action, interfaces: attempt.action.interfaces.map((row) => {
              const link = attempt.interfaceLinks!.find((link) => link.requirementKey === row.requirementKey);
              return link ? { ...row, choice: link.choice, autoSelected: false } : row;
            }) };
          }
        } else if (attempt.phase === "planning") {
          if (config.planFails?.()) {
            attempt.phase = "failed";
            attempt.action = { kind: "retry", code: "plan_run_failed", restart: true };
          } else {
            attempt.phase = "reviewable";
            attempt.action = { kind: "review_run", planRunId: `run_${id as unknown as string}`, capsuleId: "cap_office" };
          }
        }
        return read(id as unknown as string);
      },
      answerGitInstallAttempt: async (id: never, body: never) => {
        const attempt = attempts.get(id as unknown as string)!;
        attempt.generation += 1;
        const bindings = (body as { providerBindings?: readonly { moduleLocalName: string; connectionId: string }[] }).providerBindings;
        const links = (body as { interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] }).interfaceLinks;
        if (links && attempt.action.kind === "provide_inputs") {
          attempt.interfaceLinks = links;
          attempt.action = { ...attempt.action, interfaces: attempt.action.interfaces.map((row) => {
            const choice = links.find((link) => link.requirementKey === row.requirementKey)?.choice;
            return { ...row, choice, autoSelected: false };
          }), missing: attempt.action.missing.filter((field) => field !== "interfaces") };
        }
        if (bindings && attempt.action.kind === "provide_inputs") {
          attempt.action = {
            ...attempt.action,
            connections: attempt.action.connections.map((row) => {
              const chosen = bindings.find((binding) => binding.moduleLocalName === row.moduleLocalName);
              return chosen ? { ...row, selectedConnectionId: chosen.connectionId, autoSelected: false } : row;
            }),
          };
        }
        if ((body as { continue?: boolean }).continue) {
          attempt.phase = "planning";
          attempt.action = { kind: "wait", phase: "planning" };
          if (config.loseContinue?.()) throw new api.ControlApiError(503, "unavailable", "unavailable");
        }
        return read(id as unknown as string);
      },
      getGitInstallPlan: async (id: never) => read(id as unknown as string),
      discardGitInstallAttempt: async (id: never) => {
        if (config.refuseDiscard?.()) throw new api.ControlApiError(409, "install_attempt_discard_refused", "refused");
        const attempt = attempts.get(id as unknown as string)!;
        attempt.generation += 1;
        attempt.phase = "discarded";
        attempt.action = { kind: "none" };
        return read(id as unknown as string);
      },
    };
    return { handlers, creates: () => creates };
  }
  const named = (name: string) => calls.filter((call) => call.name === name);
  const settingSheet = () => inputs({
    connections: [{ ...requirement, selectedConnectionId: "conn_a" }],
    variables: [{ name: "domain", type: "string", required: false, sensitive: false }],
    missing: [],
  });

  test("retrying the first Store install recovers the accepted release after Latest advances", async () => {
    const original = { tag: "v1.4.2", commit: "0123456789abcdef0123456789abcdef01234567" };
    const newer = { tag: "v1.5.0", commit: "abcdef0123456789abcdef0123456789abcdef01" };
    let latest = original;
    const accepted = new Map<string, GitInstallPlanResponse>();
    reset({
      resolveStableSourceTag: async () => latest,
      createGitInstallAttempt: async (_workspace, body, key) => {
        const existing = accepted.get(key);
        if (existing) return existing;
        const ref = (body as { source: { ref: string } }).source.ref;
        const id = accepted.size === 0 ? ID : "gip_00000000000000b2";
        const created = withSourceRef(withoutWorkspace(respond(inputs(), 0, "awaiting_input", id)), ref);
        accepted.set(key, created);
        if (id === ID) throw new api.ControlApiError(503, "unavailable", "response lost");
        return created;
      },
    });
    personalOwnership = true;
    const page = mount(undefined, { fromStore: true });
    try {
      await page.attempt.start(candidate, { fromStore: true });
      expect(page.attemptId()).toBeUndefined();
      expect(accepted.size).toBe(1);
      latest = newer;
      await page.attempt.start(candidate, { fromStore: true });
      const starts = named("createGitInstallAttempt");
      expect(starts).toHaveLength(2);
      expect(starts[1]!.args).toEqual(starts[0]!.args);
      expect(named("resolveStableSourceTag")).toHaveLength(1);
      expect(accepted.size).toBe(1);
      expect(page.attemptId()).toBe(ID);
      expect(page.attempt.resolvedVersion()).toEqual(original);
    } finally {
      page.dispose();
    }
  });

  test("starting a different Store module resolves the current release after a lost response", async () => {
    const original = { tag: "v1.4.2", commit: "0123456789abcdef0123456789abcdef01234567" };
    const newer = { tag: "v1.5.0", commit: "abcdef0123456789abcdef0123456789abcdef01" };
    let latest = original;
    reset({
      resolveStableSourceTag: async () => latest,
      createGitInstallAttempt: async () => {
        if (latest === original) throw new api.ControlApiError(503, "unavailable", "response lost");
        return withSourceRef(withoutWorkspace(respond(inputs(), 0)), latest.commit);
      },
    });
    personalOwnership = true;
    const page = mount(undefined, { fromStore: true });
    try {
      await page.attempt.start(candidate, { fromStore: true });
      latest = newer;
      await page.attempt.start({ ...candidate, modulePath: "deploy/alternate" }, { fromStore: true });
      const starts = named("createGitInstallAttempt");
      expect(starts).toHaveLength(2);
      expect(starts[1]!.args[2]).not.toBe(starts[0]!.args[2]);
      expect(starts[1]!.args[1]).toMatchObject({ source: { ref: newer.commit }, options: { modulePath: "deploy/alternate" } });
      expect(named("resolveStableSourceTag")).toHaveLength(2);
      expect(page.attempt.resolvedVersion()).toEqual(newer);
    } finally {
      page.dispose();
    }
  });

  test("a settings replan keeps the pinned Latest selection, but explicitly entering its commit changes it", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const server = coordinator({ sheet: settingSheet });
    reset({ ...server.handlers, resolveStableSourceTag: async () => ({ tag: "v1.4.2", commit }) });
    const page = mount(undefined, { fromStore: true, settleMs: 5 });
    try {
      await page.attempt.start(candidate, { fromStore: true });
      await until(() => page.attempt.view().stage === "review", "the latest release Plan");
      page.attempt.setDraft("domain", "changed.example.com");
      await until(() => server.creates() === 2 && page.attempt.view().stage === "review", "the settings replacement Plan");
      expect(page.attempt.latestSelected()).toBe(true);
      expect(page.attempt.resolvedVersion()).toEqual({ tag: "v1.4.2", commit });
      page.attempt.changeVersion(commit);
      await until(() => server.creates() === 3 && page.attempt.view().stage === "review", "the explicitly pinned Plan");
      expect(page.attempt.latestSelected()).toBe(false);
      expect(page.attempt.resolvedVersion()).toBeUndefined();
      expect(named("resolveStableSourceTag")).toHaveLength(1);
      const starts = named("createGitInstallAttempt");
      expect(starts).toHaveLength(3);
      for (const { args } of starts) expect(args[1]).toMatchObject({ source: { ref: commit } });
    } finally {
      page.dispose();
    }
  });

  test("clearing explicit Store HEAD resolves Latest and a lost POST retries that pinned selection", async () => {
    const commit = "abcdef0123456789abcdef0123456789abcdef01";
    const server = coordinator({ sheet: settingSheet, failCreate: (count) => count === 2 });
    reset({ ...server.handlers, resolveStableSourceTag: async () => ({ tag: "v2.0.0", commit }) });
    const page = mount(undefined, { fromStore: true, settleMs: 5 });
    try {
      await page.attempt.start({ ...candidate, ref: "HEAD" }, { fromStore: true });
      await until(() => page.attempt.view().stage === "review", "the explicit HEAD Plan");
      expect(page.attempt.latestSelected()).toBe(false);
      expect(named("resolveStableSourceTag")).toHaveLength(0);
      page.attempt.setVersionDraft("");
      page.attempt.commitVersion();
      await until(() => page.attempt.view().progress === "replanPaused" && page.attempt.mutating() === undefined, "the unknown replacement outcome");
      expect(page.attempt.latestSelected()).toBe(false);
      expect(page.attempt.resolvedVersion()).toBeUndefined();
      page.attempt.resume();
      await until(() => page.attemptId() !== ID && page.attempt.view().stage === "review", "the resolved replacement Plan");
      const starts = named("createGitInstallAttempt");
      expect(starts).toHaveLength(3);
      expect(starts[1]!.args[1]).toMatchObject({ source: { ref: commit } });
      expect(starts[2]!.args).toEqual(starts[1]!.args);
      expect(named("resolveStableSourceTag")).toHaveLength(1);
      expect(named("discardGitInstallAttempt")).toHaveLength(1);
      expect(page.attempt.latestSelected()).toBe(true);
      expect(page.attempt.resolvedVersion()).toEqual({ tag: "v2.0.0", commit });
    } finally {
      page.dispose();
    }
  });

  test("a confirmation whose answer was lost but went through still dates its Plan: a later edit prepares again", async () => {
    let lose = true;
    const server = coordinator({ sheet: settingSheet, loseContinue: () => (lose ? !(lose = false) : false) });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the Plan made by the lost confirmation");
    expect(answerBodies().filter((body) => body.continue)).toHaveLength(1);
    page.attempt.setDraft("domain", "changed.example.com");
    await page.attempt.chooseConnection(requirement, "conn_b");
    // The Plan holds conn_a and no domain; the screen now shows conn_b and a
    // domain, so the Plan can no longer be applied.
    expect(page.attempt.outdated()).toBe(true);
    expect(page.attempt.view().applyBlock).toBe("replanning");
    await until(() => page.attempt.view().stage === "review" && page.attempt.response()?.installPlan.id !== ID, "the new Plan");
    const created = named("createGitInstallAttempt").map(({ args }) => args[1]);
    expect(created[1]).toMatchObject({
      options: { providerBindings: [{ provider: requirement.provider, moduleLocalName: "cloudflare", connectionId: "conn_b" }] },
    });
    expect(answerBodies().at(-1)).toMatchObject({ continue: true, variables: { domain: "changed.example.com" } });
    page.dispose();
  });

  test("an attempt reopened past its sheet treats any edit as making its Plan out of date", async () => {
    reset({ getGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 7) });
    const page = mount(ID, { settleMs: 60_000 });
    await until(() => page.attempt.view().stage === "review", "the reopened review");
    expect(page.attempt.outdated()).toBe(false);
    page.attempt.changeVersion("v2.0.0");
    expect(page.attempt.outdated()).toBe(true);
    expect(page.attempt.view().applyBlock).toBe("replanning");
    page.dispose();
  });

  test("a refused discard while preparing again waits for Continue instead of spinning, and Continue tries again", async () => {
    let refuse = true;
    const server = coordinator({ sheet: settingSheet, refuseDiscard: () => refuse });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the Plan");
    page.attempt.setDraft("domain", "changed.example.com");
    await until(() => named("discardGitInstallAttempt").length === 1 && page.attempt.mutating() === undefined, "the refused discard");
    await pause(40);
    expect(page.attempt.view()).toMatchObject({ stage: "review", applyBlock: "paused", progress: "replanPaused" });
    expect(page.attempt.error()).toBeTruthy();
    // Nothing more on its own.
    expect(named("discardGitInstallAttempt")).toHaveLength(1);
    expect(server.creates()).toBe(1);
    refuse = false;
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review" && page.attempt.response()?.installPlan.id !== ID, "the new Plan");
    expect(named("discardGitInstallAttempt")).toHaveLength(2);
    expect(server.creates()).toBe(2);
    expect(page.attempt.view().applyBlock).toBeUndefined();
    page.dispose();
  });

  test("a replacement whose start failed keeps the answers and is sent again with the same idempotency key", async () => {
    const server = coordinator({ sheet: settingSheet, failCreate: (count) => count === 2 });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the Plan");
    page.attempt.setDraft("domain", "changed.example.com");
    await until(() => server.creates() === 2 && page.attempt.mutating() === undefined, "the failed start");
    await pause(40);
    // The discarded attempt is not shown as a dead end: the screen keeps the
    // answers and waits for Continue.
    expect(page.attempt.view()).toMatchObject({ applyBlock: "paused", progress: "replanPaused" });
    expect(page.attempt.drafts()).toEqual({ domain: { value: "changed.example.com", touched: true } });
    expect(page.attempt.sheet()).toBeTruthy();
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review" && page.attempt.response()?.installPlan.id !== ID, "the new Plan");
    const starts = named("createGitInstallAttempt");
    expect(starts).toHaveLength(3);
    // The same request and key as the start whose outcome was unknown; no
    // second discard.
    expect(starts[2]!.args).toEqual(starts[1]!.args);
    expect(named("discardGitInstallAttempt")).toHaveLength(1);
    page.dispose();
  });

  test("leaving the page while preparing again sends nothing more", async () => {
    const hold = deferred<void>();
    let reconciles = 0;
    const server = coordinator({ sheet: settingSheet });
    reset({
      ...server.handlers,
      reconcileGitInstallPlan: async (id: never, init: never) => {
        reconciles += 1;
        if (reconciles >= 2) await hold.promise; // a slow command that ignores the abort
        return await server.handlers.reconcileGitInstallPlan(id);
      },
    });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => reconciles >= 2, "planning");
    page.attempt.changeVersion("v2.0.0");
    await pause(30);
    page.dispose();
    hold.resolve();
    await pause(30);
    expect(named("discardGitInstallAttempt")).toHaveLength(0);
    expect(server.creates()).toBe(1);
  });

  test("a version typed while the sheet is confirmed is held until it is left, then prepares the install again", async () => {
    const server = coordinator({ sheet: settingSheet });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setVersionDraft("v2.0");
    await pause(30);
    // While typing nothing is confirmed, and the field is not dropped.
    expect(answerBodies()).toEqual([]);
    expect(page.attempt.view().applyBlock).toBe("editing");
    page.attempt.setVersionDraft("v2.0.0");
    page.attempt.commitVersion();
    await until(() => server.creates() === 2 && page.attempt.view().stage === "review", "the Plan for the new version");
    expect(named("createGitInstallAttempt")[1]!.args[1]).toMatchObject({ source: { url: URL_, ref: "v2.0.0" } });
    // Only the new attempt's sheet was confirmed.
    expect(answerBodies()).toHaveLength(1);
    page.dispose();
  });

  test("a version changed while a confirmation is in flight is kept and prepares the install again", async () => {
    const answered = deferred<void>();
    const server = coordinator({ sheet: settingSheet });
    reset({
      ...server.handlers,
      answerGitInstallAttempt: async (id: never, body: never) => {
        if (named("answerGitInstallAttempt").length === 1) await answered.promise;
        return await server.handlers.answerGitInstallAttempt(id, body);
      },
    });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.confirming(), "the confirmation in flight");
    page.attempt.setVersionDraft("v3.0.0");
    page.attempt.commitVersion();
    expect(page.attempt.refDraft()).toBe("v3.0.0");
    answered.resolve();
    await until(() => server.creates() === 2 && page.attempt.view().stage === "review", "the Plan for the new version");
    expect(named("createGitInstallAttempt")[1]!.args[1]).toMatchObject({ source: { ref: "v3.0.0" } });
    page.dispose();
  });

  test("typed settings and an invalid name count only once left, and an invalid name holds the Plan", async () => {
    const server = coordinator({ sheet: settingSheet });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setDraft("domain", "half.exa", { typing: true });
    await pause(30);
    expect(answerBodies()).toEqual([]);
    expect(page.attempt.view().applyBlock).toBe("editing");
    page.attempt.setDraft("domain", "half.example.com", { typing: true });
    page.attempt.commitDraft("domain");
    await until(() => page.attempt.view().stage === "review", "the Plan");
    expect(answerBodies()).toEqual([{ expectedGeneration: 1, continue: true, variables: { domain: "half.example.com" } }]);
    // After the Plan, an invalid name holds it without preparing again.
    page.attempt.setNameDraft("Not Valid");
    expect(page.attempt.view().applyBlock).toBe("editing");
    await page.attempt.saveName();
    expect(page.attempt.outdated()).toBe(true);
    expect(page.attempt.view().applyBlock).toBe("invalid");
    await pause(40);
    expect(named("discardGitInstallAttempt")).toHaveLength(0);
    page.attempt.setNameDraft("valid-name");
    await page.attempt.saveName();
    await until(() => server.creates() === 2 && page.attempt.view().stage === "review", "the Plan under the new name");
    expect(named("createGitInstallAttempt")[1]!.args[1]).toMatchObject({ capsule: { name: "valid-name" } });
    page.dispose();
  });

  test("a Plan that failed keeps the answers on the screen; Try again prepares it again with them", async () => {
    let fail = true;
    const server = coordinator({
      sheet: () => inputs({ connections: [], variables: [{ name: "api_token", type: "string", required: true, sensitive: true }], missing: [] }),
      planFails: () => (fail ? !(fail = false) : false),
    });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setDraft("api_token", SECRET);
    await until(() => page.attempt.view().stage === "failed", "the failed Plan");
    expect(page.attempt.view()).toMatchObject({ applyBlock: "failed", progress: "failed" });
    expect(page.attempt.drafts()).toEqual({ api_token: { value: SECRET, touched: true } });
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review", "the Plan made again");
    expect(server.creates()).toBe(2);
    expect(answerBodies().at(-1)).toMatchObject({ continue: true, variables: { api_token: SECRET } });
    expect(JSON.stringify(named("createGitInstallAttempt"))).not.toContain(SECRET);
    page.dispose();
  });
  test("a connection chosen while a start is sent again reaches the new sheet before it is confirmed", async () => {
    const server = coordinator({ sheet: settingSheet, failCreate: (count) => count === 2 });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the Plan");
    page.attempt.setDraft("domain", "changed.example.com");
    await until(() => server.creates() === 2 && page.attempt.mutating() === undefined, "the start whose outcome is unknown");
    // While it waits for Continue, the person picks another connection.
    expect(await page.attempt.chooseConnection(requirement, "conn_b")).toBe(true);
    page.attempt.resume();
    const second = "gip_00000000000000b2";
    await until(() => page.attempt.response()?.installPlan.id === second && page.attempt.view().stage === "review", "the new Plan");
    const starts = named("createGitInstallAttempt");
    // The start is sent again exactly as it was (same key)…
    expect(starts[2]!.args).toEqual(starts[1]!.args);
    // …and the new sheet first receives the connection chosen meanwhile.
    const toSecond = named("answerGitInstallAttempt").filter(({ args }) => args[0] === second).map(({ args }) => args[1]);
    expect(toSecond).toEqual([
      { expectedGeneration: 1, providerBindings: [{ provider: requirement.provider, moduleLocalName: "cloudflare", connectionId: "conn_b" }] },
      { expectedGeneration: 2, continue: true, variables: { domain: "changed.example.com" } },
    ]);
    expect(page.attempt.connectionRows().map((row) => row.selectedConnectionId)).toEqual(["conn_b"]);
    expect(page.attempt.outdated()).toBe(false);
    page.dispose();
  });

  test("a missing app choice blocks confirmation until an inline later answer, with no extra decision", async () => {
    const server = coordinator({ sheet: () => inputs({ connections: [], variables: [], interfaces: [linkedRequirement], missing: ["interfaces"] }) });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "provide_inputs", "the app choices");
    await pause(20);
    expect(page.attempt.view()).toMatchObject({ readyToConfirm: false, applyBlock: "interfaces" });
    await page.attempt.confirm();
    expect(answerBodies()).toEqual([]);
    expect(await page.attempt.chooseInterface(linkedRequirement, { kind: "later" })).toBe(true);
    await until(() => page.attempt.view().stage === "review", "the Plan after choosing later");
    expect(answerBodies()).toEqual([
      { expectedGeneration: 1, interfaceLinks: [{ requirementKey: "chat", choice: { kind: "later" } }] },
      { expectedGeneration: 2, continue: true },
    ]);
    expect(calls.some(({ name }) => /apply|approve/u.test(name))).toBe(false);
    page.dispose();
  });

  test("zero and one candidate choices are ready without turning automatic answers into explicit ones", async () => {
    const server = coordinator({ sheet: () => inputs({ connections: [], variables: [], interfaces: [
      { ...linkedRequirement, requirementKey: "none", candidates: [], choice: { kind: "later" } },
      { ...linkedRequirement, candidates: [linkedRequirement.candidates[0]!], choice: { kind: "interface", interfaceId: "if_a" }, autoSelected: true },
    ], missing: [] }) });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the automatic Plan");
    expect(answerBodies()).toEqual([{ expectedGeneration: 1, continue: true, observedInterfaces: [
      { requirementKey: "none", candidateIds: [] },
      { requirementKey: "chat", candidateIds: ["if_a"] },
    ] }]);
    page.dispose();
  });

  test("an auto choice observed after reload is fenced on continue and a fresh sheet permits explicit later", async () => {
    let available = false;
    let explicitLater = false;
    let generation = 1;
    const currentSheet = () => {
      const row: GitInstallPlanInterfaceRequirement = available && !explicitLater
        ? { ...linkedRequirement, candidates: [linkedRequirement.candidates[0]!], choice: { kind: "interface", interfaceId: "if_a" }, autoSelected: true }
        : { ...linkedRequirement, candidates: [], choice: { kind: "later" }, autoSelected: false };
      const response = respond(inputs({ connections: [], interfaces: [row], missing: [] }), generation);
      return { ...response, installPlan: { ...response.installPlan, options: explicitLater ? { interfaceLinks: [{ requirementKey: "chat", choice: { kind: "later" as const } }] } : {} } };
    };
    reset({
      getGitInstallPlan: async () => currentSheet(),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        const patch = body as { continue?: boolean; observedInterfaces?: readonly { requirementKey: string; candidateIds: readonly string[] }[]; interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] };
        generation += 1;
        if (patch.continue) {
          if (!explicitLater) throw new api.ControlApiError(409, "interface_candidate_unavailable", "The observed candidate changed");
          return respond({ kind: "wait", phase: "planning" }, generation);
        }
        explicitLater = patch.interfaceLinks?.[0]?.choice.kind === "later";
        return currentSheet();
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, ++generation),
    });
    const page = mount(ID, { settleMs: 5 });
    try {
      await until(() => page.attempt.view().stage === "provide_inputs", "the initially empty candidates");
      expect(page.attempt.interfaceRows()[0]?.choice).toEqual({ kind: "later" });
      available = true;
      await page.attempt.reload();
      expect(page.attempt.interfaceRows()[0]).toMatchObject({ autoSelected: true, choice: { kind: "interface", interfaceId: "if_a" } });
      available = false;
      page.attempt.setDraft("api_token", SECRET);
      await page.attempt.confirm();
      expect(answerBodies()).toEqual([{
        expectedGeneration: 1, continue: true,
        observedInterfaces: [{ requirementKey: "chat", candidateIds: ["if_a"] }],
        variables: { api_token: SECRET },
      }]);
      expect(page.attempt.response()?.installPlan.generation).toBe(2);
      expect(page.attempt.interfaceRows()[0]).toMatchObject({ autoSelected: false, choice: { kind: "later" } });
      expect(page.attempt.drafts().api_token?.value).toBe(SECRET);
      expect(page.attempt.error()).toBeTruthy();
      await pause(20);
      expect(answerBodies()).toHaveLength(1);
      expect(await page.attempt.chooseInterface(page.attempt.interfaceRows()[0]!, { kind: "later" })).toBe(true);
      await until(() => page.attempt.view().stage === "review", "the Plan with explicit later");
      expect(answerBodies().slice(1)).toEqual([
        { expectedGeneration: 2, interfaceLinks: [{ requirementKey: "chat", choice: { kind: "later" } }] },
        { expectedGeneration: 3, continue: true, variables: { api_token: SECRET } },
      ]);
      expect(calls.filter(({ name }) => name === "getGitInstallPlan")).toHaveLength(3);
      expect(calls.some(({ name }) => /apply|approve/u.test(name))).toBe(false);
    } finally {
      page.dispose();
    }
  });

  test("a replayed start that already reached its sheet adopts the app rows immediately", async () => {
    reset({ createGitInstallAttempt: async () => respond(inputs({ connections: [], variables: [], interfaces: [linkedRequirement], missing: ["interfaces"] }), 2) });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    expect(page.attempt.sheet()?.kind).toBe("provide_inputs");
    expect(page.attempt.interfaceRows()).toEqual([linkedRequirement]);
    expect(page.attempt.view()).toMatchObject({ readyToConfirm: false, applyBlock: "interfaces" });
    await pause(20);
    expect(answerBodies()).toEqual([]);
    page.dispose();
  });

  test("a failed linked app answer retains the choice through refreshed sheets and retries only on Continue", async () => {
    let choice: GitInstallPlanInterfaceChoice | undefined;
    let fail = true;
    let generation = 1;
    const action = () => inputs({ connections: [], variables: [], interfaces: [{ ...linkedRequirement, choice }], missing: choice ? [] : ["interfaces"] });
    reset({
      getGitInstallPlan: async () => respond(action(), generation),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        if (fail) throw new api.ControlApiError(503, "unavailable", "unavailable");
        generation += 1;
        const patch = body as { interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[]; continue?: boolean };
        if (patch.continue) return respond({ kind: "wait", phase: "planning" }, generation);
        choice = patch.interfaceLinks?.[0]?.choice;
        return respond(action(), generation);
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, ++generation),
    });
    const page = mount(ID, { settleMs: 5 });
    await until(() => page.attempt.view().stage === "provide_inputs", "the choices");
    expect(await page.attempt.chooseInterface(linkedRequirement, { kind: "interface", interfaceId: "if_b" })).toBe(false);
    expect(page.attempt.interfaceRows()[0]?.choice).toEqual({ kind: "interface", interfaceId: "if_b" });
    await page.attempt.reload();
    await pause(25);
    expect(page.attempt.interfaceRows()[0]?.choice).toEqual({ kind: "interface", interfaceId: "if_b" });
    expect(answerBodies()).toHaveLength(1);
    fail = false;
    page.attempt.resume();
    await until(() => page.attempt.view().stage === "review", "the retried choice and Plan");
    expect(answerBodies().map((body) => body.interfaceLinks).filter(Boolean)).toEqual([
      [{ requirementKey: "chat", choice: { kind: "interface", interfaceId: "if_b" } }],
      [{ requirementKey: "chat", choice: { kind: "interface", interfaceId: "if_b" } }],
    ]);
    page.dispose();
  });

  const linkedSheet = () => inputs({ connections: [], variables: [], interfaces: [{ ...linkedRequirement, choice: { kind: "interface", interfaceId: "if_a" } }], missing: [] });

  test("a linked app changed after a failed replacement reaches its new sheet before confirmation", async () => {
    const server = coordinator({ sheet: linkedSheet, failCreate: (count) => count === 2 });
    reset(server.handlers);
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the Plan");
    page.attempt.changeVersion("v2");
    await until(() => server.creates() === 2 && page.attempt.mutating() === undefined, "the failed replacement");
    expect(await page.attempt.chooseInterface(linkedRequirement, { kind: "later" })).toBe(true);
    page.attempt.resume();
    const second = "gip_00000000000000b2";
    await until(() => page.attempt.response()?.installPlan.id === second && page.attempt.view().stage === "review", "the replacement Plan");
    expect(named("createGitInstallAttempt")[2]!.args).toEqual(named("createGitInstallAttempt")[1]!.args);
    expect(named("answerGitInstallAttempt").filter(({ args }) => args[0] === second).map(({ args }) => args[1])).toEqual([
      { expectedGeneration: 1, interfaceLinks: [{ requirementKey: "chat", choice: { kind: "later" } }] },
      { expectedGeneration: 2, continue: true },
    ]);
    expect(page.attempt.interfaceRows()[0]?.choice).toEqual({ kind: "later" });
    page.dispose();
  });

  test("an app choice edited while a replacement POST is in flight survives its older response", async () => {
    const server = coordinator({ sheet: linkedSheet });
    const replacement = deferred<void>();
    let creates = 0;
    reset({ ...server.handlers, createGitInstallAttempt: async (...args: never[]) => {
      creates += 1;
      if (creates === 2) await replacement.promise;
      return await server.handlers.createGitInstallAttempt(...args);
    } });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the first Plan");
    page.attempt.changeVersion("v2");
    await until(() => creates === 2, "the pending replacement POST");
    expect(await page.attempt.chooseInterface(linkedRequirement, { kind: "interface", interfaceId: "if_b" })).toBe(true);
    replacement.resolve();
    const second = "gip_00000000000000b2";
    await until(() => page.attempt.response()?.installPlan.id === second && page.attempt.view().stage === "review", "the new choice's Plan");
    expect(page.attempt.interfaceRows()[0]?.choice).toEqual({ kind: "interface", interfaceId: "if_b" });
    expect(named("answerGitInstallAttempt").filter(({ args }) => args[0] === second).map(({ args }) => args[1])).toEqual([
      { expectedGeneration: 1, interfaceLinks: [{ requirementKey: "chat", choice: { kind: "interface", interfaceId: "if_b" } }] },
      { expectedGeneration: 2, continue: true },
    ]);
    page.attempt.lockAnswers();
    expect(await page.attempt.chooseInterface(linkedRequirement, { kind: "later" })).toBe(false);
    page.dispose();
  });

  test("restarting an attempt opened after its sheet retains persisted linked app answers", async () => {
    const chosen = [{ requirementKey: "chat", choice: { kind: "later" as const } }];
    const failed = respond({ kind: "retry", code: "plan_run_failed", restart: true }, 5, "failed");
    const held = { ...failed, installPlan: { ...failed.installPlan, options: { interfaceLinks: chosen } } };
    const signals: AbortSignal[] = [];
    reset({
      getGitInstallPlan: async () => held,
      discardGitInstallAttempt: async () => ({ ...held, installPlan: { ...held.installPlan, phase: "discarded", generation: 6 } }),
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0, undefined, "gip_00000000000000b2"),
      reconcileGitInstallPlan: abortable(signals),
    });
    const page = mount(ID);
    await until(() => page.attempt.view().stage === "failed", "the failed attempt");
    expect(await page.attempt.restart()).toBe(true);
    expect(named("createGitInstallAttempt")[0]?.args[1]).toMatchObject({ options: { interfaceLinks: chosen } });
    page.dispose();
  });

  test("a replacement POST returning a new sheet keeps that sheet and drops retired requirement answers", async () => {
    let creates = 0;
    const server = coordinator({ sheet: () => creates === 2
      ? inputs({ connections: [], variables: [{ name: "new_setting", type: "string", required: true, sensitive: true }], interfaces: [], missing: [] })
      : linkedSheet() });
    reset({ ...server.handlers, createGitInstallAttempt: async (...args: never[]) => {
      creates += 1;
      const created = await server.handlers.createGitInstallAttempt(...args);
      return creates === 2 ? await server.handlers.reconcileGitInstallPlan(created.installPlan.id as never) : created;
    } });
    const page = mount(undefined, { settleMs: 5 });
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => page.attempt.view().stage === "review", "the first Plan");
    page.attempt.changeVersion("v2");
    await until(() => creates === 2 && page.attempt.mutating() === undefined, "the new sheet");
    expect(page.attempt.interfaceRows()).toEqual([]);
    expect(page.attempt.sheet()?.variables.map((variable) => variable.name)).toEqual(["new_setting"]);
    expect(page.attempt.view()).toMatchObject({ readyToConfirm: false, applyBlock: "settings" });
    await pause(20);
    expect(answerBodies().filter((body) => body.continue)).toHaveLength(1);
    page.dispose();
  });

  test("a typed field the new sheet no longer has stops holding the confirmation", async () => {
    let withField = true;
    reset({
      getGitInstallPlan: async () => respond(withField ? settingSheet() : inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_b" }], variables: [], missing: [] }), 3),
      answerGitInstallAttempt: async (_id: never, body: never) => {
        if ((body as { continue?: boolean }).continue) return respond({ kind: "wait", phase: "planning" }, 5);
        withField = false;
        return respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_b" }], variables: [], missing: [] }), 4);
      },
      reconcileGitInstallPlan: async () => respond({ kind: "review_run", planRunId: "run_plan", capsuleId: "cap_office" }, 6),
    });
    const page = mount(ID, { settleMs: 5 });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    page.attempt.setDraft("domain", "typing.exa", { typing: true });
    expect(page.attempt.view().applyBlock).toBe("editing");
    // The answer brings a sheet without that field: nothing waits for it.
    await page.attempt.chooseConnection(requirement, "conn_b");
    await until(() => page.attempt.view().stage === "review", "the Plan");
    expect(answerBodies().filter((body) => body.continue)).toEqual([{ expectedGeneration: 4, continue: true }]);
    page.dispose();
  });
});


test("explicit public connection settings use the current owned selection and reject stale reads", async () => {
  let current = respond(inputs({ variables: [{ name: "deployment", type: "json", required: true, sensitive: false }],
    connections: [{ ...requirement, selectedConnectionId: "conn_a" }], missing: [] }), 1);
  let release!: (rows: unknown) => void;
  const row = (id: string, account: string) => ({ id, ownerAccountId: "sub_me", scope: "workspace", workspaceId: "ws_alpha",
    providerSource: requirement.provider, status: "verified", scopeHints: { moduleInputDefaults: { cloudflare_account_id: account } } });
  const a = row("conn_a", "a".repeat(32));
  const b = row("conn_b", "b".repeat(32));
  reset({ getGitInstallPlan: async () => current,
    listConnections: async () => [a, b, { ...a, id: "unselected", ownerAccountId: "someone_else" }] });
  let principal = "sub_me";
  const page = mount(ID, { settleMs: 60_000, principalId: () => principal });
  try {
    await until(() => page.attempt.response() !== undefined, "initial sheet");
    expect(calls.filter((call) => call.name === "listConnections")).toHaveLength(0);
    await page.attempt.loadConnectionSettings();
    expect(page.attempt.connectionSettings().map((choice) => choice.connectionId)).toEqual(["conn_a"]);
    const choiceA = page.attempt.connectionSettings()[0]!;
    expect(page.attempt.applyConnectionSettings("api_token", choiceA)).toBe(false);
    const publicJson = { name: "deployment", type: "json", required: true, sensitive: false };
    current = respond(inputs({ variables: [{ ...publicJson, defaultValue: { account_id: "already-provided" } }],
      connections: [{ ...requirement, selectedConnectionId: "conn_a" }], missing: [] }), 1);
    await page.attempt.reload();
    await page.attempt.loadConnectionSettings();
    expect(page.attempt.applyConnectionSettings("deployment", page.attempt.connectionSettings()[0]!)).toBe(false);
    current = respond(inputs({ variables: [publicJson], connections: [{ ...requirement, selectedConnectionId: "conn_a" }], missing: [] }), 1);
    await page.attempt.reload();
    await page.attempt.loadConnectionSettings();
    const freshA = page.attempt.connectionSettings()[0]!;
    page.attempt.setDraft("deployment", JSON.stringify({ account_id: "manual" }));
    expect(page.attempt.applyConnectionSettings("deployment", freshA)).toBe(false);
    expect(page.attempt.drafts().deployment?.value).toContain("manual");
    page.attempt.setDraft("deployment", "");
    expect(page.attempt.applyConnectionSettings("deployment", freshA)).toBe(true);
    expect(JSON.parse(page.attempt.drafts().deployment!.value)).toEqual({ account_id: "a".repeat(32) });
    current = respond(inputs({ variables: [publicJson], connections: [{ ...requirement, selectedConnectionId: "conn_a",
      candidates: requirement.candidates.map((candidate) => ({ ...candidate, status: "revoked" })) }], missing: [] }), 1);
    await page.attempt.reload();
    expect(page.attempt.connectionSettings()).toEqual([]);
    expect(page.attempt.applyConnectionSettings("deployment", freshA)).toBe(false);
    current = respond(inputs({ variables: [{ name: "deployment", type: "json", required: true, sensitive: false }],
      connections: [{ ...requirement, selectedConnectionId: "conn_b" }], missing: [] }), 2);
    await page.attempt.reload();
    expect(page.attempt.connectionSettings()).toEqual([]);
    expect(page.attempt.applyConnectionSettings("deployment", freshA)).toBe(false);
    const { continueVariables } = await import(resolve(dashboard, "src/views/new/install-attempt.ts"));
    expect(continueVariables(current.userAction as Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>, page.attempt.drafts())).toMatchObject({ ok: false, invalid: ["deployment"] });
    handlers.listConnections = async () => new Promise((resolveRows) => { release = resolveRows; });
    const pending = page.attempt.loadConnectionSettings();
    await until(() => release !== undefined, "deferred settings read");
    current = { ...current, installPlan: { ...current.installPlan, generation: 3 } };
    await page.attempt.reload();
    release([b]);
    await pending;
    expect(page.attempt.connectionSettings()).toEqual([]);
    const principalPending = page.attempt.loadConnectionSettings();
    await settle();
    principal = "other-person";
    release([b]);
    await principalPending;
    expect(page.attempt.connectionSettings()).toEqual([]);
    principal = "sub_me";
    handlers.listConnections = async () => [b];
    await page.attempt.loadConnectionSettings();
    expect(page.attempt.applyConnectionSettings("deployment", page.attempt.connectionSettings()[0]!)).toBe(true);
    expect(continueVariables(current.userAction as Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>, page.attempt.drafts())).toEqual({ ok: true, variables: { deployment: { account_id: "b".repeat(32) } } });
    handlers.answerGitInstallAttempt = async () => respond({ kind: "wait", phase: "planning" }, 4);
    await page.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt").at(-1)?.args[1]).toMatchObject({
      continue: true, expectedGeneration: 3, variables: { deployment: { account_id: "b".repeat(32) } },
    });
    expect(calls.filter((call) => call.name === "listConnections").every((call) => call.args[0] === "ws_alpha")).toBe(true);
  } finally { page.dispose(); }
});

test("server-owned inputs remain read-only while generic derived defaults can be edited", async () => {
  const managed = {
    name: "derived_setting", type: "string" as const, required: false, sensitive: false,
    derivedDefault: "capsule_name" as const, userEditable: false,
  };
  const user = {
    name: "user_setting", type: "string" as const, required: true, sensitive: false,
    userEditable: true,
  };
  reset({
    getGitInstallPlan: async () => respond(inputs({ connections: [], interfaces: [], variables: [managed, user], missing: ["variables"] }), 1),
    answerGitInstallAttempt: async () => respond({ kind: "wait", phase: "planning" }, 2),
    reconcileGitInstallPlan: abortable([]),
  });
  const page = mount(ID);
  try {
    await until(() => page.attempt.sheet() !== undefined, "the ownership-aware sheet");
    expect(page.attempt.sheet()?.variables).toEqual([managed, user]);
    // A stale draft or programmatic setter must not escape the server's new
    // ownership projection, even though it is still held in page memory.
    page.attempt.setDraft(managed.name, "stale-derived-override");
    expect(page.attempt.view()).toMatchObject({ readyToConfirm: false, missingVariables: [user.name] });
    await page.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt")).toHaveLength(0);
    page.attempt.setDraft(user.name, "typed-user-value");
    expect(page.attempt.view().readyToConfirm).toBe(true);
    await page.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt").map((call) => call.args[1])).toEqual([
      { expectedGeneration: 1, continue: true, variables: { [user.name]: "typed-user-value" } },
    ]);
  } finally { page.dispose(); }

  // An absent ownership projection preserves generic InstallConfig behavior:
  // derivedDefault alone never makes an otherwise editable value read-only.
  const { userEditable: _ownership, ...generic } = managed;
  reset({
    getGitInstallPlan: async () => respond(inputs({ connections: [], interfaces: [], variables: [generic], missing: [] }), 1),
    answerGitInstallAttempt: async () => respond({ kind: "wait", phase: "planning" }, 2),
    reconcileGitInstallPlan: abortable([]),
  });
  const genericPage = mount(ID);
  try {
    await until(() => genericPage.attempt.sheet() !== undefined, "the generic sheet");
    expect(genericPage.attempt.view().readyToConfirm).toBe(true);
    genericPage.attempt.setDraft(generic.name, "explicit-generic-override");
    await genericPage.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt").map((call) => call.args[1])).toEqual([
      { expectedGeneration: 1, continue: true, variables: { [generic.name]: "explicit-generic-override" } },
    ]);
  } finally { genericPage.dispose(); }
});

const endpointField = { name: "public_address", type: "string" as const, required: true, sensitive: false,
  userEditable: true, format: "cloudflare-workers-url",
  publicEndpoint: { serviceNameVariable: "deployment_name", serviceNameSource: "capsule_name" as const, suggestedName: "office-compiled" } };
const endpointInputs = (name = "office", connectionId = "conn_a", resubmit = false) => inputs({
  variables: [{ ...endpointField, publicEndpoint: { ...endpointField.publicEndpoint, suggestedName: `${name}-compiled` } }],
  connections: [{ ...requirement, selectedConnectionId: connectionId }], missing: [],
  name: { current: name, proposed: name, conflict: false },
  ...(resubmit ? { resubmitVariables: [endpointField.name] } : {}),
});
const endpointConnection = (id: string, subdomain: string) => ({ id, providerSource: requirement.provider,
  ownerAccountId: "sub_me", scope: "personal", status: "verified",
  scopeHints: { moduleInputDefaults: { cloudflare_account_id: "a".repeat(32), cloudflare_workers_subdomain: subdomain },
    providerSettings: { accountId: "a".repeat(32), workersSubdomain: subdomain } } });

test("standard public URL uses server names, preserves manual URL edits, and explicitly returns to automatic", async () => {
  let current = respond(endpointInputs(), 1);
  reset({ getGitInstallPlan: async () => current,
    listConnections: async () => [endpointConnection("conn_a", "alpha"), endpointConnection("conn_b", "beta")],
    answerGitInstallAttempt: async (_id, answer) => {
      const request = answer as { capsuleName?: string };
      current = request.capsuleName
        ? respond(endpointInputs(request.capsuleName), 2)
        : respond({ kind: "wait", phase: "planning" }, 5);
      return current;
    }, reconcileGitInstallPlan: abortable([]) });
  const page = mount(ID);
  try {
    await until(() => page.attempt.drafts().public_address?.value === "https://office-compiled.alpha.workers.dev", "initial automatic URL");
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt")).toHaveLength(0);
    page.attempt.setNameDraft("renamed");
    await page.attempt.saveName();
    await until(() => page.attempt.drafts().public_address?.value === "https://renamed-compiled.alpha.workers.dev", "canonical renamed URL");
    page.attempt.setDraft("public_address", "https://custom.example", { typing: true });
    page.attempt.commitDraft("public_address");
    current = respond(endpointInputs("another", "conn_b"), 3);
    await page.attempt.reload();
    await until(() => page.attempt.connectionSettings()[0]?.connectionId === "conn_b", "new selected metadata");
    expect(page.attempt.drafts().public_address).toEqual({ value: "https://custom.example", touched: true });
    page.attempt.useStandardPublicUrl("public_address");
    await until(() => page.attempt.drafts().public_address?.value === "https://another-compiled.beta.workers.dev", "restored automatic URL");
    await page.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt").at(-1)?.args[1]).toMatchObject({
      expectedGeneration: 3, continue: true, variables: { public_address: "https://another-compiled.beta.workers.dev" },
    });
  } finally { page.dispose(); }
});

test("late metadata and failed refresh cannot confirm an old connection's standard URL", async () => {
  let current = respond(endpointInputs(), 1);
  const first = deferred<unknown[]>();
  const second = deferred<unknown[]>();
  let reads = 0;
  reset({ getGitInstallPlan: async () => current,
    listConnections: async () => ++reads === 1 ? first.promise : second.promise });
  const page = mount(ID);
  try {
    await until(() => reads === 1, "first metadata request");
    current = respond(endpointInputs("office", "conn_b"), 2);
    await page.attempt.reload();
    await until(() => reads === 2, "replacement metadata request");
    first.resolve([endpointConnection("conn_a", "old")]);
    await settle();
    expect(page.attempt.drafts().public_address).toBeUndefined();
    await page.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt")).toHaveLength(0);
    second.resolve([endpointConnection("conn_b", "current")]);
    await until(() => page.attempt.drafts().public_address?.publicEndpoint?.confirmed === true, "current metadata");
    expect(page.attempt.drafts().public_address?.value).toBe("https://office-compiled.current.workers.dev");
    handlers.listConnections = async () => { reads += 1; throw new Error("metadata unavailable"); };
    current = respond(endpointInputs("office", "conn_b"), 3);
    await page.attempt.reload();
    await until(() => reads === 3 && !page.attempt.settingsChoicesLoading(), "failed metadata refresh");
    expect(page.attempt.drafts().public_address?.publicEndpoint?.confirmed).toBe(false);
    expect(page.attempt.view().readyToConfirm).toBe(false);
    await page.attempt.confirm();
    await settle();
    expect(reads).toBe(3);
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt")).toHaveLength(0);
    handlers.listConnections = async () => [endpointConnection("conn_b", "new-current")];
    await page.attempt.loadConnectionSettings();
    await until(() => page.attempt.drafts().public_address?.value === "https://office-compiled.new-current.workers.dev", "explicit refreshed URL");
  } finally { page.dispose(); }
});

test("a failed rename cannot send the old generated URL with an unsaved app name", async () => {
  let current = respond(endpointInputs(), 1);
  reset({ getGitInstallPlan: async () => current,
    listConnections: async () => [endpointConnection("conn_a", "alpha")],
    answerGitInstallAttempt: async () => { throw new Error("rename unavailable"); } });
  const page = mount(ID);
  try {
    await until(() => page.attempt.drafts().public_address?.publicEndpoint?.confirmed === true, "initial URL");
    page.attempt.setNameDraft("renamed");
    await page.attempt.saveName();
    expect(page.attempt.nameDraft()).toBe("renamed");
    expect(page.attempt.view().readyToConfirm).toBe(false);
    expect(page.attempt.drafts().public_address?.publicEndpoint?.confirmed).toBe(false);
    await page.attempt.confirm();
    expect(calls.filter((call) => call.name === "answerGitInstallAttempt").map((call) => call.args[1]))
      .toEqual([{ expectedGeneration: 1, capsuleName: "renamed" }]);
    handlers.answerGitInstallAttempt = async () => {
      current = respond(endpointInputs("renamed"), 2);
      return current;
    };
    await page.attempt.saveName();
    await until(() => page.attempt.drafts().public_address?.value === "https://renamed-compiled.alpha.workers.dev", "accepted renamed URL");
    expect(page.attempt.view().readyToConfirm).toBe(true);
  } finally { page.dispose(); }
});

test("public URL resubmission retains the exact in-memory value and reopened inputs stay write-only", async () => {
  let current = respond(endpointInputs(), 1);
  reset({ getGitInstallPlan: async () => current,
    listConnections: async () => [endpointConnection("conn_a", "alpha")],
    answerGitInstallAttempt: async () => {
      current = respond(endpointInputs("office", "conn_a", true), 2);
      return current;
    } });
  const page = mount(ID);
  try {
    await until(() => page.attempt.drafts().public_address?.publicEndpoint?.confirmed === true, "prepared URL");
    await page.attempt.confirm();
    expect(page.attempt.view().readyToConfirm).toBe(true);
    await page.attempt.confirm();
    const answers = calls.filter((call) => call.name === "answerGitInstallAttempt").map((call) => call.args[1]);
    expect(answers).toEqual([
      { expectedGeneration: 1, continue: true, variables: { public_address: "https://office-compiled.alpha.workers.dev" },
        providerBindings: [{ provider: requirement.provider, moduleLocalName: requirement.moduleLocalName, connectionId: "conn_a" }] },
      { expectedGeneration: 2, continue: true, variables: { public_address: "https://office-compiled.alpha.workers.dev" } },
    ]);
    expect(calls.filter((call) => call.name === "listConnections")).toHaveLength(1);
  } finally { page.dispose(); }
  reset({ getGitInstallPlan: async () => current });
  const reopened = mount(ID);
  try {
    await until(() => reopened.attempt.sheet() !== undefined, "reopened resubmit sheet");
    expect(reopened.attempt.drafts()).toEqual({});
    const { sheetVariables } = await import(resolve(dashboard, "src/views/new/install-attempt.ts"));
    expect(sheetVariables(reopened.attempt.sheet()!)[0]?.sensitive).toBe(true);
    expect(calls.filter((call) => call.name === "listConnections")).toHaveLength(0);
    reopened.attempt.setDraft("public_address", "https://office-compiled.alpha.workers.dev");
    expect(reopened.attempt.view().readyToConfirm).toBe(true);
  } finally { reopened.dispose(); }
});
