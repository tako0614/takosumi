import { afterEach, describe, expect, test } from "bun:test";
import { createCapsuleConfigurationPlan } from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Capsule Configuration Plan client", () => {
  test("POSTs one complete deployment-intent review with an explicit empty blueprint array", async () => {
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
          capsule: { id: "cap_1" },
          configurationPlan: {
            replayed: false,
            previousInstallConfigId: "config_1",
            targetInstallConfigId: "config_2",
            sourceSnapshotId: "snap_1",
            planRunId: "plan_1",
          },
          links: { run: "/api/v1/runs/plan_1" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const planned = await createCapsuleConfigurationPlan("cap_1", {
      variablePatch: { set: {}, remove: [] },
      providerBindings: [],
      interfaceBlueprints: [],
      expected: { authorityGuard: `sha256:${"a".repeat(64)}` },
    }, "configuration-plan-client-test");

    expect(planned.configurationPlan.planRunId).toBe("plan_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/api/v1/capsules/cap_1/configuration-plans",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe(
      "configuration-plan-client-test",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      variablePatch: { set: {}, remove: [] },
      providerBindings: [],
      interfaceBlueprints: [],
      expected: { authorityGuard: `sha256:${"a".repeat(64)}` },
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
      createCapsuleConfigurationPlan("cap_1", {
        variablePatch: { set: {}, remove: [] },
        providerBindings: [],
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
        expected: { authorityGuard: `sha256:${"a".repeat(64)}` },
      }, "configuration-plan-invalid-blueprint"),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "blueprint.key is required",
    });
  });
});
