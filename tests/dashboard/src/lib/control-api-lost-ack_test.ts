import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  createApplyRun,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

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
      return json({ run: { id: "apply_1" } }, 201);
    }) as typeof fetch;

    await expect(createApplyRun("plan_1")).resolves.toEqual({
      run: { id: "apply_1" },
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

    await expect(createApplyRun("plan_1")).rejects.toMatchObject({
      status: 409,
      code: "failed_precondition",
    });
    expect(calls).toBe(1);
  });

  test("does not retain a malformed success body in the thrown error", async () => {
    let calls = 0;
    const rawMarker = "secret-raw-response-marker";
    globalThis.fetch = (async () => {
      calls += 1;
      return json({ capsule: rawMarker }, 201);
    }) as typeof fetch;

    let error: unknown;
    try {
      await createApplyRun("plan_invalid_success");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 502,
      code: "invalid_apply_response",
    });
    expect((error as ControlApiError).body).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(rawMarker);
    expect(calls).toBe(1);
  });

  test("makes two transport failures explicitly indeterminate", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error(`transport failure ${calls}`);
    }) as typeof fetch;

    let error: unknown;
    try {
      await createApplyRun("plan_1");
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
      return Promise.resolve(json({ run: { id: "apply_1" } }, 201));
    }) as typeof fetch;

    await expect(
      createApplyRun("plan_timeout", { timeoutMs: 1 }),
    ).resolves.toEqual({ run: { id: "apply_1" } });
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
      createApplyRun("plan_delayed_rejection", { timeoutMs: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "failed_precondition" });
    expect(calls).toBe(1);
  });
});
