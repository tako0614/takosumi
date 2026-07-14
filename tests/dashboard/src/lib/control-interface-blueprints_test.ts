import { afterEach, describe, expect, test } from "bun:test";
import { patchInstallConfig } from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("InstallConfig Interface blueprint client", () => {
  test("PATCHes the canonical field and preserves an explicit empty array", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        url: typeof input === "string" ? input : String(input),
        ...(init ? { init } : {}),
      });
      return new Response(
        JSON.stringify({
          installConfig: {
            id: "config_1",
            name: "Example",
            interfaceBlueprints: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const updated = await patchInstallConfig("config_1", {
      interfaceBlueprints: [],
    });

    expect(updated.interfaceBlueprints).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/capsule-configs/config_1");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      interfaceBlueprints: [],
    });
  });

  test("preserves the control API's canonical schema validation message", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message: "blueprint.key is required",
            requestId: "req_1",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      patchInstallConfig("config_1", {
        interfaceBlueprints: [
          {
            key: "",
            name: "runtime.api",
            spec: {
              type: "example.protocol",
              version: "1",
              document: {},
              access: { visibility: "workspace" },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "blueprint.key is required",
    });
  });
});
