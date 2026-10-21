import { expect, jest, spyOn, test } from "bun:test";
import { createRequestPhaseDiagnostics } from "../../../../accounts/service/src/request-phase-diagnostics.ts";
import {
  handleAuthenticatedControlRoute,
  handleControlRoute,
} from "../../../../accounts/service/src/control-routes.ts";
import {
  InMemoryAccountsStore,
  type AccountsBearerCredentialCandidates,
} from "../../../../accounts/service/src/store.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function collector() {
  const rows: Record<string, unknown>[] = [];
  const spy = spyOn(console, "info").mockImplementation((value) => {
    if (typeof value === "string") rows.push(JSON.parse(value));
  });
  return { rows, spy };
}

test("phase diagnostics default off and remain off in production even with opt-in", async () => {
  const { rows, spy } = collector();
  try {
    for (const configuration of [
      {},
      { environment: "staging" },
      { environment: "staging", enabled: "false" },
      { environment: "production", enabled: "true" },
      { environment: "local", enabled: "true" },
    ]) {
      const factory = createRequestPhaseDiagnostics(configuration);
      const observer = factory.forRequest(
        new Request("https://app.example.test/api/v1/runs/private-id"),
      );
      expect(await observer.measure("control_auth", () => "unchanged")).toBe(
        "unchanged",
      );
      expect(factory.activePendingNotifications).toBe(0);
    }
    expect(rows).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

test("phase diagnostics expose only a public route template and validated correlation IDs", async () => {
  const { rows, spy } = collector();
  const factory = createRequestPhaseDiagnostics({
    environment: "staging",
    enabled: "true",
  });
  const request = new Request(
    "https://private-host-marker.test/api/v1/runs/private-run-marker?secret-query-marker=1",
    {
      headers: {
        authorization: "Bearer secret-token-marker",
        cookie: "secret-cookie-marker",
        "cf-ray": "secret-ray-marker",
        "x-takosumi-request-probe-id": "secret-probe-marker",
      },
    },
  );
  try {
    const value = { privateResult: "secret-result-marker" };
    expect(
      await factory
        .forRequest(request)
        .measure("control_dispatch", () => value),
    ).toBe(value);
    expect(rows.map((row) => row.outcome)).toEqual(["started", "fulfilled"]);
    expect(rows.every((row) => row.route === "/api/v1/runs/{runId}")).toBe(
      true,
    );
    const text = JSON.stringify(rows);
    for (const marker of [
      "private-host-marker",
      "private-run-marker",
      "secret-query-marker",
      "secret-token-marker",
      "secret-cookie-marker",
      "secret-ray-marker",
      "secret-probe-marker",
      "secret-result-marker",
    ])
      expect(text).not.toContain(marker);
    await factory
      .forRequest(
        new Request("https://app.example.test/unknown-private-marker"),
      )
      .measure("control_auth", () => undefined);
    expect(rows).toHaveLength(2);
    expect(factory.activePendingNotifications).toBe(0);
    const count = rows.length;
    await factory
      .forRequest(request)
      .measure("private-phase-marker" as "control_auth", () => undefined);
    expect(rows).toHaveLength(count);
  } finally {
    spy.mockRestore();
  }
});

test("billing Organization GET diagnostics preserve the operation and redact the selected Workspace", async () => {
  const { rows, spy } = collector();
  const factory = createRequestPhaseDiagnostics({ environment: "staging", enabled: "true" });
  const request = new Request(
    "https://private-host-marker.test/api/v1/account/shared-workspaces/private-workspace-marker/billing-organization?private-query-marker=1",
    { headers: { authorization: "Bearer private-bearer-marker", cookie: "private-cookie-marker" } },
  );
  const original = { privateResult: "private-result-marker" };
  const rejected = new Error("private-rejection-marker");
  try {
    const observer = factory.forRequest(request);
    expect(await observer.measure("shared_workspace_dispatch", () => original)).toBe(original);
    await expect(observer.measure("shared_workspace_auth", () => { throw rejected; })).rejects.toBe(rejected);
    expect(rows.map((row) => row.outcome)).toEqual(["started", "fulfilled", "started", "rejected"]);
    expect(rows.every((row) => row.route === "/api/v1/account/shared-workspaces/{workspaceId}/billing-organization" && row.method === "GET")).toBe(true);
    for (const marker of ["private-host-marker", "private-workspace-marker", "private-query-marker", "private-bearer-marker", "private-cookie-marker", "private-result-marker", "private-rejection-marker"]) expect(JSON.stringify(rows)).not.toContain(marker);
    const count = rows.length;
    for (const [method, path] of [
      ["POST", "/api/v1/account/shared-workspaces/private-workspace-marker/billing-organization"],
      ["GET", "/api/v1/account/shared-workspaces//billing-organization"],
      ["GET", "/api/v1/account/shared-workspaces/private-workspace-marker/billing-organization/extra"],
    ]) {
      expect(await factory.forRequest(new Request(`https://app.example.test${path}`, { method })).measure("shared_workspace_dispatch", () => original)).toBe(original);
    }
    expect(rows).toHaveLength(count);
    for (const configuration of [{}, { environment: "staging", enabled: "false" }, { environment: "production", enabled: "true" }]) {
      expect(await createRequestPhaseDiagnostics(configuration).forRequest(request).measure("shared_workspace_dispatch", () => original)).toBe(original);
    }
    expect(rows).toHaveLength(count);
    expect(factory.activePendingNotifications).toBe(0);
  } finally { spy.mockRestore(); }
});

test("pending auth diagnostics observe the real bearer lookup without timing out or dispatching it", async () => {
  let release:
    | ((value: AccountsBearerCredentialCandidates) => void)
    | undefined;
  const candidates = new Promise<AccountsBearerCredentialCandidates>(
    (resolve) => {
      release = resolve;
    },
  );
  class PendingBearerStore extends InMemoryAccountsStore {
    calls = 0;
    async resolveAccountsBearerCandidates() {
      this.calls += 1;
      return await candidates;
    }
  }
  const store = new PendingBearerStore();
  const request = new Request(
    "https://app.example.test/api/v1/runs/private-run-marker",
    { headers: { authorization: "Bearer private-token-marker" } },
  );
  const factory = createRequestPhaseDiagnostics({
    environment: "staging",
    enabled: "true",
  });
  const { rows, spy } = collector();
  let resolvedOperations = 0;
  jest.useFakeTimers();
  try {
    let settled = false;
    const pending = handleControlRoute({
      request,
      url: new URL(request.url),
      store,
      diagnostics: factory.forRequest(request),
      resolveOperations: async () => {
        resolvedOperations += 1;
        return undefined;
      },
    });
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(store.calls).toBe(1);
    expect(factory.activePendingNotifications).toBe(1);
    jest.advanceTimersByTime(2000);
    await flush();
    expect(settled).toBe(false);
    expect(resolvedOperations).toBe(0);
    expect(rows).toContainEqual(
      expect.objectContaining({ phase: "control_auth", outcome: "pending" }),
    );
    expect(factory.activePendingNotifications).toBe(0);
    release!({});
    await flush();
    expect((await pending)?.status).toBe(401);
    expect(resolvedOperations).toBe(0);
    expect(rows.at(-1)).toMatchObject({
      phase: "control_auth",
      outcome: "fulfilled",
    });
    const count = rows.length;
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(rows).toHaveLength(count);
  } finally {
    release!({});
    jest.useRealTimers();
    spy.mockRestore();
  }
});

test("pending dispatch diagnostics keep the real route pending until its operation settles", async () => {
  let release: ((value: { items: never[]; total: number }) => void) | undefined;
  const inventory = new Promise<{ items: never[]; total: number }>(
    (resolve) => {
      release = resolve;
    },
  );
  let dispatches = 0;
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => {
        dispatches += 1;
        return await inventory;
      },
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/views/workspaces.v1",
  );
  const factory = createRequestPhaseDiagnostics({
    environment: "staging",
    enabled: "true",
  });
  const { rows, spy } = collector();
  jest.useFakeTimers();
  try {
    let settled = false;
    const pending = handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store: new InMemoryAccountsStore(),
      subject: "tsub_fixture",
      operations,
      diagnostics: factory.forRequest(request),
    });
    void pending.then(() => {
      settled = true;
    });
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    expect(settled).toBe(false);
    expect(dispatches).toBe(1);
    expect(rows).toContainEqual(
      expect.objectContaining({
        phase: "control_dispatch",
        outcome: "pending",
      }),
    );
    release!({ items: [], total: 0 });
    expect((await pending)?.status).toBe(200);
    expect(dispatches).toBe(1);
    expect(factory.activePendingNotifications).toBe(0);
  } finally {
    release!({ items: [], total: 0 });
    jest.useRealTimers();
    spy.mockRestore();
  }
});

test("pending notifications have a fixed budget and release slots even for never-settling I/O", async () => {
  const factory = createRequestPhaseDiagnostics({
    environment: "staging",
    enabled: "true",
  });
  const observer = factory.forRequest(
    new Request("https://app.example.test/api/v1/workspaces"),
  );
  const { rows, spy } = collector();
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.useFakeTimers();
  try {
    const operations = Array.from({ length: 200 }, () =>
      observer.measure("control_auth", () => blocked),
    );
    await flush();
    expect(factory.activePendingNotifications).toBe(64);
    jest.advanceTimersByTime(2000);
    await flush();
    expect(rows.filter((row) => row.outcome === "pending")).toHaveLength(64);
    expect(factory.activePendingNotifications).toBe(0);
    release!();
    await Promise.all(operations);
    const count = rows.length;
    jest.advanceTimersByTime(20_000);
    expect(rows).toHaveLength(count);
    expect(factory.activePendingNotifications).toBe(0);
    await observer.measure("control_auth", () => undefined);
    expect(factory.activePendingNotifications).toBe(0);
  } finally {
    release!();
    jest.useRealTimers();
    spy.mockRestore();
  }
});

test("observer settlement cleanup and logging failures preserve results and original rejection identity", async () => {
  const factory = createRequestPhaseDiagnostics({
    environment: "staging",
    enabled: "true",
  });
  const observer = factory.forRequest(
    new Request("https://app.example.test/api/v1/workspaces"),
  );
  const spy = spyOn(console, "info").mockImplementation(() => {
    throw new Error("logger-unavailable-marker");
  });
  try {
    expect(await observer.measure("control_auth", () => 42)).toBe(42);
    const error = new Error("private-error-marker");
    await expect(
      observer.measure("control_auth", () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(factory.activePendingNotifications).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
