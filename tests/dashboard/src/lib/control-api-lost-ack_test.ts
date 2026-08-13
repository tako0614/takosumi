import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  createApplyRun,
  createCapsule,
  type Capsule,
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

function activeCapsule(overrides: Partial<Capsule> = {}): Capsule {
  return {
    id: "cap_created",
    workspaceId: "workspace_1",
    projectId: "project_1",
    name: "service",
    slug: "service",
    sourceId: "source_1",
    installConfigId: "config_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

const capsuleInput = {
  workspaceId: "workspace_1",
  projectId: "project_1",
  name: "service",
  environment: "production",
  sourceId: "source_1",
  installConfigId: "config_1",
} as const;

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

describe("createCapsule acknowledgement recovery", () => {
  test("adopts one exact active Capsule after a lost create response", async () => {
    const candidate = activeCapsule();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let listReads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (method === "GET") {
        listReads += 1;
        return json({ capsules: listReads === 1 ? [] : [candidate] });
      }
      throw new Error("create response lost");
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).resolves.toEqual(candidate);
    expect(calls).toEqual([
      {
        url: "/api/v1/workspaces/workspace_1/capsules?includeDestroyed=false",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/v1/workspaces/workspace_1/capsules",
        method: "POST",
        body: {
          name: "service",
          environment: "production",
          projectId: "project_1",
          sourceId: "source_1",
          installConfigId: "config_1",
        },
      },
      {
        url: "/api/v1/workspaces/workspace_1/capsules?includeDestroyed=false",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  test("fails closed when readback has multiple newly appeared active Capsules", async () => {
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json({ error: { code: "upstream_failure" } }, 502);
      }
      listReads += 1;
      return json({
        capsules:
          listReads === 1
            ? []
            : [candidate("cap_a"), candidate("cap_b")],
      });
    }) as typeof fetch;

    let error: unknown;
    try {
      await createCapsule(capsuleInput);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
      causeSummary: {
        category: "http",
        status: 502,
        code: "upstream_failure",
      },
    });
    expect((error as ControlApiIndeterminateError).body).toBeUndefined();
    expect((error as ControlApiIndeterminateError).cause).toBeUndefined();
    expect(posts).toBe(1);
    expect(listReads).toBe(2);
  });

  test("fails closed when the one newly appeared active Capsule mismatches", async () => {
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        throw new Error("create response lost");
      }
      listReads += 1;
      return json({
        capsules:
          listReads === 1
            ? []
            : [candidate("cap_mismatch", { sourceId: "other_source" })],
      });
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).rejects.toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
    });
    expect(posts).toBe(1);
    expect(listReads).toBe(2);
  });

  test("does not adopt a pre-existing pending Capsule that becomes active", async () => {
    const existing = candidate("cap_existing", { status: "pending" });
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        throw new Error("create response lost");
      }
      listReads += 1;
      return json({
        capsules:
          listReads === 1
            ? [existing]
            : [candidate("cap_existing", { status: "active" })],
      });
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).rejects.toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
    });
    expect(posts).toBe(1);
    expect(listReads).toBe(2);
  });

  test("rejects a malformed baseline before issuing the create", async () => {
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") posts += 1;
      return json({ capsules: [{ id: "malformed", status: "pending" }] });
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).rejects.toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
    });
    expect(posts).toBe(0);
  });

  test("rejects a missing baseline capsules envelope before issuing the create", async () => {
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") posts += 1;
      return json({});
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).rejects.toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
    });
    expect(posts).toBe(0);
  });

  test("validates a successful response before returning it", async () => {
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json({ capsule: {} }, 201);
      }
      listReads += 1;
      return json({ capsules: [] });
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).rejects.toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
    });
    expect(posts).toBe(1);
    // A malformed successful response is read back exactly once; it is never
    // treated as permission to send a second create.
    expect(listReads).toBe(2);
  });

  test("does not return an unrelated full-shaped successful Capsule response", async () => {
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json(
          { capsule: candidate("cap_unrelated", { name: "other-service" }) },
          201,
        );
      }
      listReads += 1;
      return json({ capsules: [] });
    }) as typeof fetch;

    let error: unknown;
    try {
      await createCapsule(capsuleInput);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "request_indeterminate",
      operation: "capsule_create",
    });
    expect(posts).toBe(1);
    expect(listReads).toBe(2);
  });

  test("does not read back or retry after a definite create rejection", async () => {
    let posts = 0;
    let reads = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json(
          {
            error: {
              code: "failed_precondition",
              message: "duplicate Capsule",
            },
          },
          409,
        );
      }
      reads += 1;
      return json({ capsules: [] });
    }) as typeof fetch;

    await expect(createCapsule(capsuleInput)).rejects.toMatchObject({
      status: 409,
      code: "failed_precondition",
    });
    expect(posts).toBe(1);
    // Exactly one baseline read; a definite rejection never triggers recovery.
    expect(reads).toBe(1);
  });
});

function candidate(id: string, overrides: Partial<Capsule> = {}): Capsule {
  return activeCapsule({ id, ...overrides });
}
