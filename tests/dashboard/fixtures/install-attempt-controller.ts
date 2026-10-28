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
  gitPlanReconcileDelayMs: () => 1,
}));

const workspaceListPath = resolve(dashboard, "src/lib/workspace-list.ts");
const workspaceList = await import(workspaceListPath);
mock.module(workspaceListPath, () => ({
  ...workspaceList,
  listWorkspacesCached: async () => [{ id: "ws_alpha" }],
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

function mount(initialAttemptId?: string) {
  let dispose!: () => void;
  const [attemptId, setAttemptId] = solid.createSignal<string | undefined>(initialAttemptId);
  const left: string[] = [];
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
    });
  });
  return { attempt, dispose, attemptId, left };
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

  test("Stop installing waits for the in-flight reconcile and never overlaps it", async () => {
    const reconcile = deferred<GitInstallPlanResponse>();
    let reconciles = 0;
    reset({
      createGitInstallAttempt: async () => respond({ kind: "wait", phase: "syncing_source" }, 0),
      reconcileGitInstallPlan: async () => {
        reconciles += 1;
        return reconciles === 1 ? reconcile.promise : respond({ kind: "wait", phase: "syncing_source" }, 9);
      },
      discardGitInstallAttempt: async (_id: never, generation: never) =>
        respond({ kind: "none" }, (generation as number) + 1, "discarded"),
    });
    const page = mount();
    await page.attempt.start(candidate, { fromStore: false });
    await until(() => reconciles === 1, "the first reconcile");
    const stopping = page.attempt.discard();
    await new Promise((done) => setTimeout(done, 10));
    expect(calls.some(({ name }) => name === "discardGitInstallAttempt")).toBe(false);
    reconcile.resolve(respond({ kind: "wait", phase: "compiling_install" }, 1));
    expect(await stopping).toBe(true);
    const discards = calls.filter(({ name }) => name === "discardGitInstallAttempt");
    expect(discards.map(({ args }) => args)).toEqual([[ID, 1]]);
    expect(maxInFlight).toBe(1);
    expect(page.left).toEqual([ID]);
    expect(page.attempt.view().stage).toBe("candidate");
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
