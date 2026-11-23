import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  createApplyRun,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

const plan = { id: "plan_1", type: "plan", capsuleId: "cap_1", workspaceId: "ws_1" } as const;
const apply = { ...plan, id: "apply_1", type: "apply", planRunId: plan.id } as const;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}


describe("createApplyRun acknowledgement recovery", () => {
  test("replays the exact PlanRun once after a lost response", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let attempts = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      attempts += 1;
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (attempts === 1) throw new Error("commit response lost");
      return json({ run: apply }, 201);
    }) as typeof fetch;

    await expect(createApplyRun(plan)).resolves.toEqual({
      run: apply,
    });
    expect(calls).toEqual([
      {
        url: "/api/v1/runs/plan_1/apply",
        method: "POST",
        body: {},
      },
      {
        url: "/api/v1/runs/plan_1/apply",
        method: "POST",
        body: {},
      },
    ]);
  });

  test("does not retry a definite HTTP rejection", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return json(
        {
          error: {
            code: "failed_precondition",
            message: "plan is no longer applicable",
          },
        },
        409,
      );
    }) as typeof fetch;

    await expect(createApplyRun(plan)).rejects.toMatchObject({
      status: 409,
      code: "failed_precondition",
    });
    expect(calls).toBe(1);
  });

  test("signs in again at the same Plan after a confirmed logout without resending Apply", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    const destinations: string[] = [];
    const calls: string[] = [];
    const review = "/runs/plan_1?activity=review#plan";
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        pathname: "/runs/plan_1",
        search: "?activity=review",
        hash: "#plan",
        assign: (target: string) => { destinations.push(target); },
      },
    });
    globalThis.fetch = (async (input, init) => {
      calls.push((init?.method ?? "GET") + " " + String(input));
      return json({ error: "invalid_token" }, 401);
    }) as typeof fetch;
    try {
      await expect(createApplyRun(plan, { isCurrent: () => true })).rejects.toMatchObject({
        status: 401,
        code: "unauthorized",
      });
      expect(destinations).toEqual(["/sign-in?return=" + encodeURIComponent(review)]);
      expect(calls).toEqual(["POST /api/v1/runs/plan_1/apply"]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
      else Reflect.deleteProperty(globalThis, "location");
    }
  });

  test.each(["unauthorized", "missing response", "accepted"] as const)(
    "ignores %s once the reviewed screen has retired",
    async (outcome) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
      const destinations: string[] = [];
      const calls: string[] = [];
      let current = true;
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: {
          pathname: "/runs/replacement",
          search: "",
          hash: "",
          assign: (target: string) => { destinations.push(target); },
        },
      });
      globalThis.fetch = (async (input, init) => {
        calls.push(`${init?.method} ${String(input)}`);
        current = false;
        if (outcome === "unauthorized") return json({ error: "invalid_token" }, 401);
        if (outcome === "accepted") return json({ run: apply }, 201);
        throw new TypeError("response lost");
      }) as typeof fetch;
      const options = { timeoutMs: 1_000, isCurrent: () => current };
      try {
        const outcome = await createApplyRun(plan, options).then(() => "accepted", () => "retired");
        expect({ calls, destinations, outcome }).toEqual({
          calls: ["POST /api/v1/runs/plan_1/apply"],
          destinations: [],
          outcome: "retired",
        });
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
        else Reflect.deleteProperty(globalThis, "location");
      }
    },
  );

  test("does not retain a malformed success body in the thrown error", async () => {
    let calls = 0;
    const rawMarker = "secret-raw-response-marker";
    globalThis.fetch = (async () => {
      calls += 1;
      return json({ capsule: rawMarker }, 201);
    }) as typeof fetch;

    let error: unknown;
    try {
      await createApplyRun({ ...plan, id: "plan_invalid_success" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      operation: "apply",
      code: "request_indeterminate",
      causeSummary: { status: 502, code: "invalid_apply_response" },
    });
    expect((error as ControlApiError).body).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(rawMarker);
    expect(calls).toBe(1);
  });

  test.each([
    ["empty Run ID", { id: "" }],
    ["the review's own ID", { id: plan.id }],
    ["another Plan", { planRunId: "another_plan" }],
    ["unlinked Run", { planRunId: undefined }],
    ["another app", { capsuleId: "another_app" }],
    ["another Workspace", { workspaceId: "another_workspace" }],
    ["another Run type", { type: "destroy_apply" }],
  ] as const)("treats an acknowledgement with %s as indeterminate", async (_label, change) => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(`${init?.method} ${String(input)}`);
      return json({ run: { ...apply, ...change } }, 201);
    }) as typeof fetch;
    await expect(createApplyRun(plan)).rejects.toMatchObject({
      operation: "apply",
      code: "request_indeterminate",
      causeSummary: { status: 502, code: "invalid_apply_response" },
    });
    expect(calls).toEqual(["POST /api/v1/runs/plan_1/apply"]);
  });

  test("binds a successful Destroy acknowledgement to its own review", async () => {
    const destroyPlan = { ...plan, type: "destroy_plan" as const };
    const destroyApply = { ...apply, type: "destroy_apply" };
    globalThis.fetch = (async () => json({ run: destroyApply }, 201)) as typeof fetch;
    await expect(createApplyRun(destroyPlan)).resolves.toEqual({ run: destroyApply });
  });

  test("leaves HTTP 5xx to read-only reconciliation without resending Apply", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return json({ error: "gateway_unavailable" }, 503);
    }) as typeof fetch;

    await expect(createApplyRun(plan)).rejects.toMatchObject({
      operation: "apply",
      code: "request_indeterminate",
      causeSummary: { status: 503, code: "gateway_unavailable" },
    });
    expect(calls).toBe(1);
  });

  test("a rejected replay cannot resolve an earlier missing acknowledgement", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("response not received");
      return json({ error: "failed_precondition" }, 409);
    }) as typeof fetch;

    await expect(createApplyRun(plan)).rejects.toMatchObject({
      operation: "apply",
      code: "request_indeterminate",
      causeSummary: { status: 409, code: "failed_precondition" },
    });
    expect(calls).toBe(2);
  });

  test("makes two transport failures explicitly indeterminate", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error(`transport failure ${calls}`);
    }) as typeof fetch;

    let error: unknown;
    try {
      await createApplyRun(plan);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ControlApiIndeterminateError);
    expect(error).toBeInstanceOf(ControlApiError);
    expect(error).toMatchObject({
      code: "request_indeterminate",
      operation: "apply",
      isIndeterminate: true,
    });
    expect(calls).toBe(2);
  });

  test("retries one request timeout with the same PlanRun id", async () => {
    let calls = 0;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "AbortError"));
          });
        });
      }
      return Promise.resolve(json({ run: { ...apply, planRunId: "plan_timeout" } }, 201));
    }) as typeof fetch;

    await expect(
      createApplyRun({ ...plan, id: "plan_timeout" }, { timeoutMs: 1 }),
    ).resolves.toEqual({ run: { ...apply, planRunId: "plan_timeout" } });
    expect(calls).toBe(2);
  });

  test("does not retry a definite HTTP rejection parsed after the timer fires", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;
      if (calls > 1) throw new Error("unexpected retry");
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The timer has elapsed, but the HTTP response itself is definite.
      expect(init?.signal?.aborted).toBe(true);
      return json(
        {
          error: {
            code: "failed_precondition",
            message: "plan is no longer applicable",
          },
        },
        409,
      );
    }) as typeof fetch;

    await expect(
      createApplyRun({ ...plan, id: "plan_delayed_rejection" }, { timeoutMs: 1, isCurrent: () => true }),
    ).rejects.toMatchObject({ status: 409, code: "failed_precondition" });
    expect(calls).toBe(1);
  });
});
