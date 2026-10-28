/**
 * Behavior of the install page's attempt controller (TASK-0115 Phase 3b)
 * against a scripted coordinator. Invoked by
 * tests/dashboard/src/views/new/install-attempt-controller_test.ts with
 * --conditions=browser so Solid's reactive build runs the effects.
 */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { GitInstallPlanResponse, GitInstallPlanUserAction } from "takosumi-contract";

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
): GitInstallPlanResponse {
  return {
    installPlan: {
      id: ID,
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

const requirement = {
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  moduleLocalName: "cloudflare",
  candidates: [
    { id: "conn_a", displayName: "A", status: "verified", scope: "workspace" },
    { id: "conn_b", displayName: "B", status: "verified", scope: "workspace" },
  ],
  autoSelected: false,
} as const;

function inputs(overrides: Record<string, unknown> = {}): GitInstallPlanUserAction {
  return {
    kind: "provide_inputs",
    modulePath: ".",
    resources: [],
    connections: [requirement],
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
function mount(initialAttemptId?: string) {
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
    // Once confirmed, the values are gone from the page's memory.
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

  test("values typed for a confirmation whose answer was lost are dropped once it went through", async () => {
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
});
