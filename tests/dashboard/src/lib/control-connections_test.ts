import { afterEach, describe, expect, test } from "bun:test";
import {
  getCapsuleProviderBindingSet,
  listConnections,
  listConnectionsWithSignal,
  listProviderConnections,
  listProviderConnectionsWithSignal,
  listReleaseOwnedProviderConnectionsWithSignal,
  putCapsuleProviderBindingSet,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

function stubFetch(): () => readonly string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    return new Response(
      JSON.stringify({
        connections: [],
        providerConnections: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("connection list clients", () => {
  test("skip network requests until a Workspace id is known", async () => {
    const calls = stubFetch();

    expect(await listConnections("")).toEqual([]);
    expect(await listConnections("   ")).toEqual([]);
    expect(await listConnections(undefined as unknown as string)).toEqual([]);
    expect(await listProviderConnections("")).toEqual([]);
    expect(await listProviderConnections("   ")).toEqual([]);
    expect(
      await listProviderConnections(undefined as unknown as string),
    ).toEqual([]);

    expect(calls()).toEqual([]);
  });

  test("use normalized Workspace ids when loading Connections", async () => {
    const calls = stubFetch();

    expect(await listConnections(" space_1 ")).toEqual([]);
    expect(await listProviderConnections(" space_1 ")).toEqual([]);
    expect(
      await listReleaseOwnedProviderConnectionsWithSignal(" space_1 "),
    ).toEqual([]);

    expect(calls()).toEqual([
      "/api/v1/connections?workspaceId=space_1",
      "/api/v1/provider-connections?workspaceId=space_1",
      "/api/v1/provider-connections?workspaceId=space_1&projection=release-owned",
    ]);
  });

  test("propagate cancellation to both connection discovery requests", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("connection discovery omitted its AbortSignal"));
          return;
        }
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;

    const controller = new AbortController();
    const pending = Promise.all([
      listConnectionsWithSignal("space_1", controller.signal),
      listProviderConnectionsWithSignal("space_1", controller.signal),
      listReleaseOwnedProviderConnectionsWithSignal(
        "space_1",
        controller.signal,
      ),
    ]);
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });
});

describe("Capsule ProviderBinding client", () => {
  test("uses only the canonical route and binding payload", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    const providerBindingSet = {
      id: "pbs_1",
      workspaceId: "ws_1",
      capsuleId: "cap_1",
      environment: "production",
      bindings: [
        {
          provider: "registry.opentofu.org/hashicorp/aws",
          connectionId: "conn_1",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        url: typeof input === "string" ? input : String(input),
        ...(init ? { init } : {}),
      });
      return new Response(JSON.stringify({ providerBindingSet }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await getCapsuleProviderBindingSet("cap_1")).toEqual(
      providerBindingSet,
    );
    expect(
      await putCapsuleProviderBindingSet("cap_1", providerBindingSet.bindings),
    ).toEqual(providerBindingSet);

    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/capsules/cap_1/provider-bindings",
      "/api/v1/capsules/cap_1/provider-bindings",
    ]);
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      bindings: providerBindingSet.bindings,
    });
    expect(JSON.stringify(calls)).not.toContain("providerConnectionSet");
  });
});
