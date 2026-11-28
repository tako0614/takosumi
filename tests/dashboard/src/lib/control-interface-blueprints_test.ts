import { afterEach, describe, expect, test } from "bun:test";
import { createCapsuleConfigurationPlan, getCapsuleConfigurationContext, resumeCapsuleConfigurationPlan } from "../../../../dashboard/src/lib/control-api.ts";

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

  test("requires a Plan identifier and fences a retired configuration request", async () => {
    let posts = 0;
    globalThis.fetch = (async () => {
      posts++;
      return Response.json({ configurationPlan: {} });
    }) as typeof fetch;
    const request = {
      variablePatch: { set: {}, remove: [] }, providerBindings: [], interfaceBlueprints: [],
      expected: { authorityGuard: `sha256:${"a".repeat(64)}` },
    };
    await expect(createCapsuleConfigurationPlan("cap_1", request, "same", { isCurrent: () => false }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(posts).toBe(0);
    await expect(createCapsuleConfigurationPlan("cap_1", request, "same"))
      .rejects.toMatchObject({ code: "invalid_configuration_plan_response" });
    expect(posts).toBe(1);
  });

  test("resuming settings preserves a definite conflict and treats an incomplete one as unconfirmed", async () => {
    const calls: RequestInit[] = [];
    const replies = [
      Response.json({ error: { code: "failed_precondition", message: "Configuration changed.", details: { reason: "authority_changed" } } }, { status: 409 }),
      new Response('{"error":', { status: 409, headers: { "content-type": "application/json" } }),
    ];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/v1/capsules/cap_1/configuration-plans");
      calls.push(init!);
      return replies.shift()!;
    }) as typeof fetch;
    const resume = { installConfigId: "config_2", authorityGuard: `sha256:${"a".repeat(64)}` };
    await expect(resumeCapsuleConfigurationPlan("cap_1", resume)).rejects.toMatchObject({
      status: 409, code: "failed_precondition", reason: "authority_changed", isIndeterminate: false,
    });
    await expect(resumeCapsuleConfigurationPlan("cap_1", resume)).rejects.toMatchObject({
      operation: "configuration_plan", isIndeterminate: true,
    });
    expect(calls.map(({ method, body }) => ({ method, body: JSON.parse(String(body)) })))
      .toEqual([{ method: "POST", body: { resume } }, { method: "POST", body: { resume } }]);
  });

  test("ignores a 401 from a configuration context read whose view retired", async () => {
    const reply = Promise.withResolvers<Response>();
    const dispatched = Promise.withResolvers<void>();
    globalThis.fetch = (async () => {
      dispatched.resolve();
      return await reply.promise;
    }) as typeof fetch;
    let current = true;
    const read = getCapsuleConfigurationContext("cap_1", { isCurrent: () => current });
    await dispatched.promise;
    current = false;
    reply.resolve(new Response(null, { status: 401 }));
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
});
