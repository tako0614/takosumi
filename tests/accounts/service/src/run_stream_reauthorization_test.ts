import { expect, test } from "bun:test";
import type { Run } from "../../../../contract/runs.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import {
  handleAuthenticatedControlRoute,
  handleControlRoute,
} from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { runStatusStream } from "../../../../accounts/service/src/control/runs.ts";

const workspace = {
  id: "ws_stream",
  ownerUserId: "owner",
  handle: "stream",
  displayName: "Stream",
  type: "team" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function fixture() {
  let now = 0;
  let memberStatus: "active" | "revoked" | "error" = "active";
  let currentRun: Run = {
    id: "run_stream",
    workspaceId: workspace.id,
    type: "plan",
    status: "running",
    createdBy: "owner",
    createdAt: workspace.createdAt,
  };
  const pending: Array<() => void> = [];
  let memberReads = 0;
  let runReads = 0;
  const operations = {
    workspaces: { getWorkspace: async () => workspace },
    members: {
      getMember: async () => {
        memberReads++;
        if (memberStatus === "error") throw new Error("private membership error");
        return memberStatus === "active"
          ? {
              id: "member",
              workspaceId: workspace.id,
              accountId: "tsub_viewer",
              roles: ["viewer"],
              status: "active",
              createdAt: workspace.createdAt,
              updatedAt: workspace.updatedAt,
            }
          : undefined;
      },
    },
    getRun: async () => {
      runReads++;
      return currentRun;
    },
  } as unknown as ControlPlaneOperations;
  const requestAbort = new AbortController();
  const request = new Request("https://example.test/api/v1/runs/run_stream/stream", {
    signal: requestAbort.signal,
  });
  const ctx = {
    request,
    url: new URL(request.url),
    operations,
    store: {} as ControlDispatchContext["store"],
    session: {
      subject: "tsub_viewer",
      requiredAccess: "read",
      reauthorizeBearer: async () => true,
    },
  } satisfies ControlDispatchContext;
  const timing = {
    now: () => now,
    wait: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        if (signal.aborted) done();
        else {
          signal.addEventListener("abort", done, { once: true });
          pending.push(done);
        }
      }),
  };
  const tick = async (ms: number) => {
    now += ms;
    const next = pending.shift();
    if (!next) throw new Error("no pending poll");
    next();
    await Bun.sleep(0);
  };
  return {
    ctx,
    timing,
    tick,
    requestAbort,
    get memberReads() { return memberReads; },
    get runReads() { return runReads; },
    setMemberStatus: (status: typeof memberStatus) => { memberStatus = status; },
    setRun: (run: Run) => { currentRun = run; },
    getRun: () => currentRun,
  };
}

async function firstFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value)).toContain('"run_stream"');
}

async function routedStream(
  f: ReturnType<typeof fixture>,
  store: InMemoryAccountsStore,
  headers: HeadersInit,
) {
  const request = new Request(f.ctx.request.url, { headers });
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    operations: f.ctx.operations,
    store,
    runStreamTiming: f.timing,
  });
  expect(response?.status).toBe(200);
  const reader = response!.body!.getReader();
  await firstFrame(reader);
  return reader;
}

test("ordinary PAT route closes a stream when the persisted token is revoked", async () => {
  const f = fixture();
  const store = new InMemoryAccountsStore();
  const token = "opaque-run-stream-pat";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_run_stream",
    tokenPrefix: "display",
    subject: "tsub_viewer",
    name: "Run reader",
    scopes: ["read"],
    workspaceId: workspace.id,
    createdAt: Date.now(),
  });
  const reader = await routedStream(f, store, { authorization: `Bearer ${token}` });
  store.revokePersonalAccessToken({
    subject: "tsub_viewer",
    tokenId: "pat_run_stream",
    revokedAt: Date.now(),
  });
  f.setRun({ ...f.getRun(), heartbeatAt: 1 });
  await f.tick(60_000);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(f.runReads).toBe(1);
});

test("ordinary PAT route closes after a scope or identity change", async () => {
  for (const change of ["scope", "identity"] as const) {
    const f = fixture();
    const store = new InMemoryAccountsStore();
    const token = `opaque-run-stream-${change}`;
    const record = {
      tokenId: `pat_run_stream_${change}`,
      tokenPrefix: "display",
      subject: "tsub_viewer" as const,
      name: "Run reader",
      scopes: ["read" as const],
      workspaceId: workspace.id,
      createdAt: Date.now(),
    };
    store.savePersonalAccessToken(token, record);
    const reader = await routedStream(f, store, { authorization: `Bearer ${token}` });
    store.savePersonalAccessToken(token, change === "scope"
      ? { ...record, scopes: [] }
      : { ...record, subject: "tsub_other" });
    f.setRun({ ...f.getRun(), heartbeatAt: 1 });
    await f.tick(2_500);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(f.runReads).toBe(2);
  }
});

test("ordinary bearer lookup error closes the stream without an error frame", async () => {
  const f = fixture();
  let failLookup = false;
  class FailingStore extends InMemoryAccountsStore {
    override findPersonalAccessToken(token: string) {
      if (failLookup) throw new Error("private bearer lookup failure");
      return super.findPersonalAccessToken(token);
    }
  }
  const store = new FailingStore();
  const token = "opaque-run-stream-lookup";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_run_stream_lookup",
    tokenPrefix: "display",
    subject: "tsub_viewer",
    name: "Run reader",
    scopes: ["read"],
    workspaceId: workspace.id,
    createdAt: Date.now(),
  });
  const reader = await routedStream(f, store, { authorization: `Bearer ${token}` });
  failLookup = true;
  f.setRun({ ...f.getRun(), heartbeatAt: 1 });
  await f.tick(60_000);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(f.runReads).toBe(1);
});

test("ordinary OAuth bearer route cannot switch its principal during a stream", async () => {
  const f = fixture();
  const store = new InMemoryAccountsStore();
  const token = "opaque-run-stream-oauth";
  const record = {
    clientId: "client_stream",
    scope: "capsules:read",
    subject: "client-local-subject",
    takosumiSubject: "tsub_viewer" as const,
    workspaceId: workspace.id,
    expiresAt: Date.now() + 60_000,
  };
  store.saveAccessToken(token, record);
  const reader = await routedStream(f, store, { authorization: `Bearer ${token}` });
  store.saveAccessToken(token, { ...record, subject: "other-client-principal" });
  f.setRun({ ...f.getRun(), heartbeatAt: 1 });
  await f.tick(2_500);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(f.runReads).toBe(2);
});

test("ordinary cookie session route closes a stream when the session expires", async () => {
  const f = fixture();
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const sessionId = "sess_run_stream";
  store.saveAccount({ subject: "tsub_viewer", createdAt: now, updatedAt: now });
  store.saveAccountSession({
    sessionId,
    subject: "tsub_viewer",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const reader = await routedStream(f, store, {
    cookie: `takosumi_session=${sessionId}`,
  });
  store.saveAccountSession({
    sessionId,
    subject: "tsub_viewer",
    createdAt: now,
    expiresAt: now - 1,
  });
  f.setRun({ ...f.getRun(), heartbeatAt: 1 });
  await f.tick(60_000);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(f.runReads).toBe(1);
});

test("in-process authenticated route cannot open a stream without renewable credentials", async () => {
  const f = fixture();
  const response = await handleAuthenticatedControlRoute({
    request: f.ctx.request,
    url: f.ctx.url,
    operations: f.ctx.operations,
    store: f.ctx.store,
    subject: "tsub_viewer",
    workspaceId: workspace.id,
    runStreamTiming: f.timing,
  });
  expect(response?.status).toBe(403);
  expect(f.runReads).toBe(1);
});

test.each(["revoked", "error"] as const)(
  "run stream closes before a changed run leaks after membership %s",
  async (status) => {
    const f = fixture();
    const response = runStatusStream(f.ctx, "run_stream", f.getRun(), f.timing);
    const reader = response.body!.getReader();
    await firstFrame(reader);
    f.setMemberStatus(status);
    f.setRun({ ...f.getRun(), heartbeatAt: 1 });
    await f.tick(60_000);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(f.memberReads).toBeGreaterThanOrEqual(2);
  },
);

test("run stream does not emit the initial snapshot when authorization is revoked", async () => {
  const f = fixture();
  f.setMemberStatus("revoked");
  const reader = runStatusStream(f.ctx, "run_stream", f.getRun(), f.timing).body!.getReader();
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(f.runReads).toBe(0);
});

test("run stream closes if the refreshed run changes Workspace", async () => {
  const f = fixture();
  const reader = runStatusStream(f.ctx, "run_stream", f.getRun(), f.timing).body!.getReader();
  await firstFrame(reader);
  f.setRun({ ...f.getRun(), workspaceId: "ws_other", heartbeatAt: 1 });
  await f.tick(2_500);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
});

test("run stream closes at lifetime cap before another projection read", async () => {
  const f = fixture();
  const reader = runStatusStream(f.ctx, "run_stream", f.getRun(), f.timing).body!.getReader();
  await firstFrame(reader);
  const before = f.runReads;
  await f.tick(8 * 60_000);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(f.runReads).toBe(before);
});

test("run stream abort and reader cancellation stop polling", async () => {
  for (const close of ["abort", "cancel"] as const) {
    const f = fixture();
    const reader = runStatusStream(f.ctx, "run_stream", f.getRun(), f.timing).body!.getReader();
    await firstFrame(reader);
    if (close === "abort") {
      f.requestAbort.abort();
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } else {
      await reader.cancel();
    }
    expect(f.runReads).toBe(0);
  }
});

test("run stream sends terminal state and closes", async () => {
  const f = fixture();
  const reader = runStatusStream(f.ctx, "run_stream", f.getRun(), f.timing).body!.getReader();
  await firstFrame(reader);
  f.setRun({ ...f.getRun(), status: "succeeded" });
  await f.tick(2_500);
  const terminal = await reader.read();
  expect(new TextDecoder().decode(terminal.value)).toContain('"succeeded"');
  expect(await reader.read()).toEqual({ done: true, value: undefined });
});
