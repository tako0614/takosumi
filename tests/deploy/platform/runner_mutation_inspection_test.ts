import { expect, test } from "bun:test";
import { handlePlatformRunnerMutationInspectionRequest } from "../../../deploy/platform/worker.ts";

const path = "https://app.takosumi.com/internal/platform/runner-mutation?runId=apply_76f606db8cc34ac7";
const authorization = { authorization: "Bearer operator-secret" };

function fixture(operation = "create") {
  const calls: { id: unknown; method: string; path: string }[] = [];
  const env = {
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret",
    RUNNER: {
      idFromName: (name: string) => `id:${name}`,
      get: (id: unknown) => ({
        inspectMutationAuthority: async (runId: string, action: string, workspaceId: string) => {
          calls.push({ id, method: "RPC", path: `inspectMutationAuthority:${runId}:${action}:${workspaceId}` });
          return {
            kind: "takosumi.runner-mutation-inspection@v1",
            authority: {
              status: "valid",
              action: "apply",
              phase: "indeterminate",
              version: 1,
              fence: 1,
              redispatchBlocked: true,
            },
            dispatch: { status: "matching" },
            target: {
              status: "present",
              stateRef: "must-never-return-state-path",
              rawOutputRef: "must-never-return-output-path",
            },
            secret: "must-never-be-returned",
          };
        },
      }),
    },
  } as never;
  const getApplyRun = async (id: string) => ({
      id,
      operation,
      status: "failed",
      workspaceId: "space_1",
    }) as never;
  return { env, getApplyRun, calls };
}

test("runner mutation inspection requires deploy-control auth and GET", async () => {
  const { env, getApplyRun, calls } = fixture();
  const url = new URL(path);
  for (const request of [
    new Request(url),
    new Request(url, { method: "POST", headers: authorization }),
  ]) {
    const response = await handlePlatformRunnerMutationInspectionRequest(request, url, env, { getApplyRun });
    expect(response.status).toBe(request.method === "POST" ? 405 : 401);
  }
  expect(calls).toEqual([]);
});

test("runner mutation inspection validates exact ApplyRun before routing", async () => {
  const { env, getApplyRun, calls } = fixture("plan");
  for (const target of [
    path.replace("apply_76f606db8cc34ac7", "bad"),
    path,
  ]) {
    const url = new URL(target);
    const response = await handlePlatformRunnerMutationInspectionRequest(
      new Request(url, { headers: authorization }), url, env, { getApplyRun },
    );
    expect(response.status).toBe(target.endsWith("bad") ? 400 : 409);
  }
  expect(calls).toEqual([]);
});

test("runner mutation inspection rejects duplicate IDs and a mismatched Run lookup", async () => {
  const { env, calls } = fixture();
  const duplicate = new URL(`${path}&runId=apply_76f606db8cc34ac7`);
  expect((await handlePlatformRunnerMutationInspectionRequest(
    new Request(duplicate, { headers: authorization }), duplicate, env,
  )).status).toBe(400);
  const url = new URL(path);
  const response = await handlePlatformRunnerMutationInspectionRequest(
    new Request(url, { headers: authorization }), url, env,
    { getApplyRun: async () => ({ id: "apply_other1234", operation: "create", workspaceId: "space_1" }) as never },
  );
  expect(response.status).toBe(409);
  expect(calls).toEqual([]);
});

test("runner mutation inspection addresses exact Runner DO and strips unknown payload", async () => {
  const { env, getApplyRun, calls } = fixture();
  const url = new URL(path);
  const response = await handlePlatformRunnerMutationInspectionRequest(
    new Request(url, { headers: authorization }), url, env, { getApplyRun },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    runId: "apply_76f606db8cc34ac7",
    runType: "apply",
    inspection: {
      kind: "takosumi.runner-mutation-inspection@v1",
      authority: {
        status: "valid",
        action: "apply",
        phase: "indeterminate",
        version: 1,
        fence: 1,
        redispatchBlocked: true,
      },
      dispatch: { status: "matching" },
      target: { status: "present" },
    },
  });
  expect(calls).toEqual([{
    id: "id:apply_76f606db8cc34ac7",
    method: "RPC",
    path: "inspectMutationAuthority:apply_76f606db8cc34ac7:apply:space_1",
  }]);
  expect(JSON.stringify(body)).not.toContain("must-never-return");
});

test("runner mutation inspection treats mismatched action as conflict, without leaking DO fields", async () => {
  const { env, getApplyRun } = fixture("destroy");
  const url = new URL(path);
  const response = await handlePlatformRunnerMutationInspectionRequest(
    new Request(url, { headers: authorization }), url, env, { getApplyRun },
  );
  expect(response.status).toBe(409);
  const body = await response.json() as { inspection: { target: { status: string } } };
  expect(body.inspection.target.status).toBe("conflicting");
  expect(JSON.stringify(body)).not.toContain("must-never-be-returned");
});

test("runner mutation inspection fails closed on malformed DO response", async () => {
  const { env, getApplyRun } = fixture();
  (env as { RUNNER: { get: (id: unknown) => { inspectMutationAuthority: () => Promise<unknown> } } }).RUNNER.get = () => ({
    inspectMutationAuthority: async () => ({ secret: "must-never-be-returned" }),
  });
  const url = new URL(path);
  const response = await handlePlatformRunnerMutationInspectionRequest(
    new Request(url, { headers: authorization }), url, env, { getApplyRun },
  );
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain("must-never-be-returned");
});

test("runner mutation inspection never falls back to fetch on an older DO", async () => {
  const { env, getApplyRun } = fixture();
  let fetchCalled = false;
  (env as { RUNNER: { get: (id: unknown) => { fetch: (request: Request) => Promise<Response> } } }).RUNNER.get = () => ({
    fetch: async () => {
      fetchCalled = true;
      return Response.json({});
    },
  });
  const url = new URL(path);
  const response = await handlePlatformRunnerMutationInspectionRequest(
    new Request(url, { headers: authorization }), url, env, { getApplyRun },
  );
  expect(response.status).toBe(503);
  expect(fetchCalled).toBe(false);
});

test("runner mutation inspection cannot bootstrap a missing Control D1 schema", async () => {
  const { env, calls } = fixture();
  const queries: string[] = [];
  (env as { TAKOSUMI_CONTROL_DB: unknown }).TAKOSUMI_CONTROL_DB = {
    prepare(sql: string) {
      queries.push(sql);
      const statement = {
        bind: () => statement,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => { throw new Error("read-only inspection attempted a write"); },
      };
      return statement;
    },
  };
  const url = new URL(path);
  const response = await handlePlatformRunnerMutationInspectionRequest(
    new Request(url, { headers: authorization }), url, env,
  );
  expect(response.status).toBe(503);
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((sql) => /^\s*(select|with|pragma)\b/i.test(sql))).toBe(true);
  expect(calls).toEqual([]);
});
