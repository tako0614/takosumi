import { afterEach, describe, expect, test } from "bun:test";
import {
  listConnections,
  listProviderConnections,
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

    expect(calls()).toEqual([
      "/api/v1/connections?workspaceId=space_1",
      "/api/v1/provider-connections?workspaceId=space_1",
    ]);
  });
});
