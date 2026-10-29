/**
 * Wire shapes of the install attempt routes (TASK-0115 Phase 3b). The client
 * only starts, reads, answers, advances and discards attempts; approval and
 * apply stay on the Run routes.
 */
import { afterEach, expect, test } from "bun:test";
import {
  answerGitInstallAttempt,
  createGitInstallAttempt,
  discardGitInstallAttempt,
  getGitInstallPlan,
  listOpenGitInstallAttempts,
  reconcileGitInstallPlan,
} from "../../../../dashboard/src/lib/control-api.ts";

const ID = "gip_0123456789abcdef";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Call = { url: string; method: string; key: string | null; body: unknown };

function record(reply: (call: Call) => unknown = () => ({
  installPlan: { id: ID, workspaceId: "ws_one", createdBy: "user_one", generation: 2 },
  nextAction: "none",
  userAction: { kind: "none" },
})): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      key: new Headers(init?.headers).get("idempotency-key"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("starting sends the value-free attempt body with the caller's key", async () => {
  const calls = record();
  await createGitInstallAttempt(
    "ws_one",
    { mode: "attempt", source: { url: "https://github.com/example/office.git" } },
    "key_one",
  );
  expect(calls).toEqual([{
    url: "/api/v1/install-plans",
    method: "POST",
    key: "key_one",
    body: { mode: "attempt", source: { url: "https://github.com/example/office.git" } },
  }]);
});

test("reading is one GET; advancing is the explicit reconcile command", async () => {
  const calls = record();
  await getGitInstallPlan(ID);
  await reconcileGitInstallPlan(ID);
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    `GET /api/v1/install-plans/${ID}`,
    `POST /api/v1/install-plans/${ID}/reconcile`,
  ]);
});

test("an answer is a generation-fenced PATCH; discarding sends the generation in the body", async () => {
  const calls = record();
  await answerGitInstallAttempt(ID, { expectedGeneration: 2, capsuleName: "office" });
  await discardGitInstallAttempt(ID, 3);
  expect(calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
    { method: "PATCH", url: `/api/v1/install-plans/${ID}`, body: { expectedGeneration: 2, capsuleName: "office" } },
    { method: "DELETE", url: `/api/v1/install-plans/${ID}`, body: { expectedGeneration: 3 } },
  ]);
});

test("the open list asks only for open attempts and keeps this workspace's", async () => {
  const calls = record(() => ({
    installPlans: [
      { installPlan: { id: ID, workspaceId: "ws_one" } },
      { installPlan: { id: "gip_ffffffffffffffff", workspaceId: "ws_other" } },
    ],
  }));
  const open = await listOpenGitInstallAttempts("ws_one");
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "GET /api/v1/workspaces/ws_one/install-plans?open=1",
  ]);
  expect(open.map((entry) => entry.installPlan.id)).toEqual([ID]);
});

test("none of the attempt routes approves or applies", async () => {
  const calls = record();
  await createGitInstallAttempt("ws_one", { mode: "attempt", source: { url: "https://x.example/r.git" } }, "k");
  await getGitInstallPlan(ID);
  await reconcileGitInstallPlan(ID);
  await answerGitInstallAttempt(ID, { expectedGeneration: 2, continue: true });
  await discardGitInstallAttempt(ID, 3);
  await listOpenGitInstallAttempts("ws_one");
  expect(calls.some(({ url }) => /\/(approve|apply)$/u.test(url))).toBe(false);
});
