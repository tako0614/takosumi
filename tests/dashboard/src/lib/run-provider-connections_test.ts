import { describe, expect, test } from "bun:test";
import type {
  ProviderConnection,
  ProviderResolution,
} from "../../../../dashboard/src/lib/control-api.ts";
import {
  createRunProviderConnectionRequestLoader,
  loadRunProviderConnections,
  providerConnectionIdsFromResolutions,
  type RunProviderConnectionLoaders,
} from "../../../../dashboard/src/lib/run-provider-connections.ts";

const NOW = "2026-08-16T00:00:00.000Z";

function connection(
  id: string,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id,
    provider: "registry.example.test/example/provider",
    providerSource: "registry.example.test/example/provider",
    scope: "workspace",
    status: "verified",
    materialization: "provider",
    envNames: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resolution(
  connectionId: string | undefined,
  evidenceConnectionId = connectionId,
): ProviderResolution {
  return {
    requirement: {
      providerSource: "registry.example.test/example/provider",
      providerName: "example",
      modulePath: ".",
      discoveredFrom: "required_providers",
      requiredForPhases: ["plan"],
    },
    status: connectionId
      ? "resolved_provider_connection"
      : "blocked_missing_connection",
    ...(connectionId ? { connectionId } : {}),
    evidence:
      evidenceConnectionId !== undefined
        ? {
            kind: "provider_connection",
            provider: "registry.example.test/example/provider",
            connectionId: evidenceConnectionId,
            materialization: "provider",
            requiredEnvNames: [],
          }
        : {
            kind: "blocked",
            provider: "registry.example.test/example/provider",
            reason: "missing connection",
          },
  };
}

function loaders(
  calls: string[],
  releaseOwned: readonly ProviderConnection[],
  workspace: readonly ProviderConnection[] | Error,
): RunProviderConnectionLoaders {
  return {
    releaseOwned: async (workspaceId, signal) => {
      calls.push(`release:${workspaceId}:${signal ? "signal" : "no-signal"}`);
      return releaseOwned;
    },
    workspace: async (workspaceId, signal) => {
      calls.push(`workspace:${workspaceId}:${signal ? "signal" : "no-signal"}`);
      if (workspace instanceof Error) throw workspace;
      return workspace;
    },
  };
}

describe("Run provider connection loading", () => {
  test("derives unique exact IDs from resolution and evidence", () => {
    expect(
      providerConnectionIdsFromResolutions([
        resolution("conn_1"),
        resolution(undefined, "conn_2"),
        resolution("conn_1"),
        resolution(undefined),
      ]),
    ).toEqual(["conn_1", "conn_2"]);
  });

  test("uses release-owned connections without reading the durable list", async () => {
    const calls: string[] = [];
    const signal = new AbortController().signal;
    const release = connection("conn_release");

    await expect(
      loadRunProviderConnections(
        "workspace_1",
        ["conn_release"],
        signal,
        loaders(calls, [release], new Error("durable list must not load")),
      ),
    ).resolves.toEqual([release]);
    expect(calls).toEqual(["release:workspace_1:signal"]);
  });

  test("loads missing exact IDs and lets release-owned rows win duplicates", async () => {
    const calls: string[] = [];
    const release = connection("conn_release");
    const releaseDuplicate = connection("conn_shared", {
      scope: "operator",
      displayName: "Release authority",
    });
    const workspaceDuplicate = connection("conn_shared", {
      displayName: "Workspace copy",
    });
    const workspaceOnly = connection("conn_workspace");

    await expect(
      loadRunProviderConnections(
        "workspace_1",
        ["conn_release", "conn_shared", "conn_workspace"],
        undefined,
        loaders(
          calls,
          [release, releaseDuplicate],
          [workspaceDuplicate, workspaceOnly, connection("unreferenced")],
        ),
      ),
    ).resolves.toEqual([releaseDuplicate, workspaceOnly, release]);
    expect(calls).toEqual([
      "release:workspace_1:no-signal",
      "workspace:workspace_1:no-signal",
    ]);
  });

  test("surfaces a durable-list failure instead of returning an empty Map", async () => {
    const calls: string[] = [];
    const failure = new Error("durable list unavailable");

    await expect(
      loadRunProviderConnections(
        "workspace_1",
        ["conn_workspace"],
        undefined,
        loaders(calls, [], failure),
      ),
    ).rejects.toBe(failure);
    expect(calls).toEqual([
      "release:workspace_1:no-signal",
      "workspace:workspace_1:no-signal",
    ]);
  });

  test("aborts an obsolete release read before it can reach durable fallback", async () => {
    const releaseSignals: AbortSignal[] = [];
    let workspaceCalls = 0;
    const loaders: RunProviderConnectionLoaders = {
      releaseOwned: async (_workspaceId, signal) => {
        if (!signal) throw new Error("missing request signal");
        releaseSignals.push(signal);
        return await new Promise<readonly ProviderConnection[]>(
          (_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason ??
                    new DOMException("The operation was aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        );
      },
      workspace: async () => {
        workspaceCalls += 1;
        return [];
      },
    };
    const requestLoader = createRunProviderConnectionRequestLoader(loaders);
    const first = requestLoader.load("workspace_1", ["conn_release"]);
    const second = requestLoader.load("workspace_1", ["conn_release"]);

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(releaseSignals[0]?.aborted).toBe(true);
    expect(workspaceCalls).toBe(0);

    requestLoader.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(releaseSignals[1]?.aborted).toBe(true);
    expect(workspaceCalls).toBe(0);
  });

  test("aborts an active read when the source transitions to zero IDs", async () => {
    const releaseSignals: AbortSignal[] = [];
    let releaseCalls = 0;
    let workspaceCalls = 0;
    const requestLoader = createRunProviderConnectionRequestLoader({
      releaseOwned: async (_workspaceId, signal) => {
        releaseCalls += 1;
        if (!signal) throw new Error("missing request signal");
        releaseSignals.push(signal);
        return await new Promise<readonly ProviderConnection[]>(
          (_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason ??
                    new DOMException("The operation was aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        );
      },
      workspace: async () => {
        workspaceCalls += 1;
        return [];
      },
    });
    const active = requestLoader.load("workspace_1", ["conn_release"]);

    // This is the empty JSON request RunView sends on an ids -> zero
    // transition; loading it aborts the active request before the helper's
    // no-read result resolves.
    const emptyRequest = requestLoader.load("", []);
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(releaseSignals[0]?.aborted).toBe(true);
    expect(workspaceCalls).toBe(0);

    await expect(emptyRequest).resolves.toEqual([]);
    expect(releaseCalls).toBe(1);
  });

  test("does not read either source when no exact IDs are referenced", async () => {
    const calls: string[] = [];

    await expect(
      loadRunProviderConnections(
        "workspace_1",
        [],
        undefined,
        loaders(calls, [connection("unreferenced")], [
          connection("also_unreferenced"),
        ]),
      ),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  test("matches IDs exactly, without provider or display-name inference", async () => {
    const calls: string[] = [];
    const wrongId = connection("conn_1", {
      providerSource: "registry.example.test/example/provider",
      displayName: "The same visible account",
    });
    const exact = connection("conn_10", {
      providerSource: wrongId.providerSource,
      displayName: wrongId.displayName,
    });

    await expect(
      loadRunProviderConnections(
        "workspace_1",
        ["conn_10"],
        undefined,
        loaders(calls, [wrongId], [exact]),
      ),
    ).resolves.toEqual([exact]);
    expect(calls).toEqual([
      "release:workspace_1:no-signal",
      "workspace:workspace_1:no-signal",
    ]);
  });
});
