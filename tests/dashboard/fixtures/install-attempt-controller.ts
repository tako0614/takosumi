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
  getGitInstallPlan: scripted("getGitInstallPlan"),
  reconcileGitInstallPlan: scripted("reconcileGitInstallPlan"),
  answerGitInstallAttempt: scripted("answerGitInstallAttempt"),
  discardGitInstallAttempt: scripted("discardGitInstallAttempt"),
  resolveStableSourceTag: scripted("resolveStableSourceTag"),
  createWorkspace: scripted("createWorkspace"),
  // The real delay schedule is kept; the pause itself is virtual (see mount).
}));

const workspaceListPath = resolve(dashboard, "src/lib/workspace-list.ts");
const workspaceList = await import(workspaceListPath);
let workspaces: readonly { readonly id: string }[] = [{ id: "ws_alpha" }];
mock.module(workspaceListPath, () => ({
  ...workspaceList,
  listWorkspacesCached: async () => workspaces,
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
function mount(initialAttemptId?: string, mountOptions: { readonly settleMs?: number } = {}) {
  let dispose!: () => void;
  const [attemptId, setAttemptId] = solid.createSignal<string | undefined>(initialAttemptId);
  const left: string[] = [];
  const pauses: number[] = [];
  const clock = { now: 0 };
  const attempt = solid.createRoot((disposeRoot: () => void) => {
    dispose = disposeRoot;
    return useInstallAttempt({
      principalId: "sub_me",
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
    });
  });
  return { attempt, dispose, attemptId, left, pauses, clock };
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

  test("an attempt opened before the workspace is chosen waits for it, then reads the attempt", async () => {
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

  test("an attempt opened with no workspace to read it in says so instead of loading forever", async () => {
    reset({});
    setCurrentWorkspaceId("");
    workspaces = [];
    try {
      const { t } = await import(resolve(dashboard, "src/i18n/index.ts"));
      const page = mount(ID);
      await until(() => page.attempt.view().stage === "unavailable", "the refusal");
      expect(page.attempt.error()).toBe(t("installStore.error.noWorkspace"));
      expect(calls).toEqual([]);
      page.dispose();
    } finally {
      workspaces = [{ id: "ws_alpha" }];
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
    expect(page.attemptId()).toBe(ID);
    expect(reconciles).toBe(2);
    expect(calls.some(({ name }) => /apply|approve/u.test(name))).toBe(false);
    page.dispose();
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
    reset({
      getGitInstallPlan: async () =>
        continues === 0
          ? respond(inputs({ connections: [{ ...requirement, selectedConnectionId: "conn_a", autoSelected: true }], missing: [] }), generation)
          : respond(inputs({ connections: [], missing: [], resubmitVariables: ["api_token"] }), generation),
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
      { expectedGeneration: 5, continue: true, variables: { api_token: SECRET } },
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
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: async () => respond(inputs(), 1),
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: true });
    await until(() => page.attempt.view().stage === "provide_inputs", "the sheet");
    const start = calls.find(({ name }) => name === "createGitInstallAttempt");
    expect(start?.args[1]).toEqual({ mode: "attempt", source: { url: URL_, ref: commit } });
    expect(page.attempt.resolvedVersion()).toEqual({ tag: "v1.4.2", commit });
    page.dispose();
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
    const attempts = new Map<string, { generation: number; phase: string; action: GitInstallPlanUserAction; interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] }>();
    let creates = 0;
    const read = (id: string) => {
      const attempt = attempts.get(id)!;
      const response = respond(attempt.action, attempt.generation, attempt.phase, id);
      return { ...response, installPlan: { ...response.installPlan, options: { ...(attempt.interfaceLinks !== undefined ? { interfaceLinks: attempt.interfaceLinks } : {}) } } };
    };
    const handlers = {
      createGitInstallAttempt: async (_workspaceId?: never, request?: never) => {
        creates += 1;
        if (config.failCreate?.(creates)) throw new api.ControlApiError(503, "unavailable", "unavailable");
        const id = ids[attempts.size]!;
        const links = (request as { options?: { interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] } } | undefined)?.options?.interfaceLinks;
        attempts.set(id, { generation: 0, phase: "syncing_source", action: { kind: "wait", phase: "syncing_source" }, ...(links !== undefined ? { interfaceLinks: links } : {}) });
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
    expect(answerBodies()).toEqual([{ expectedGeneration: 1, continue: true }]);
    page.dispose();
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
