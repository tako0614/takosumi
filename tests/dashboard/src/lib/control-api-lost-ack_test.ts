import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  createApplyRun,
  createCapsule,
  createSource,
  SourceCreateIndeterminateError,
  type Capsule,
  type Source,
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

describe("createSource acknowledgement recovery", () => {
  test("projects only an acknowledged Source and one-shot hook secret", async () => {
    const source = sourceRecord();
    const calls: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input)}`);
      if (method === "POST") {
        return json(
          { source, hookSecret: "hook_secret_once", requestId: "req_1", recovery: "evil" },
          201,
        );
      }
      return json({ sources: [] });
    }) as typeof fetch;

    const result = await createSource(sourceInput);
    expect(result).toEqual({ source, hookSecret: "hook_secret_once" });
    expect(result).not.toHaveProperty("requestId");
    expect(result).not.toHaveProperty("recovery");
    expect(calls).toEqual([
      "GET /api/v1/sources?workspaceId=workspace_1&limit=100",
      "POST /api/v1/sources",
    ]);
  });

  test("adopts exactly one newly appeared Source only on a second read-only attempt", async () => {
    const candidate = sourceRecord();
    const calls: Array<{ url: string; method: string }> = [];
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "POST") {
        posts += 1;
        throw new Error("create response lost");
      }
      listReads += 1;
      return json({ sources: listReads <= 2 ? [] : [candidate] });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    expect(first.reconciliationToken.baselineIds).toEqual([]);
    expect(posts).toBe(1);
    expect(listReads).toBe(2);

    await expect(
      createSource({
        ...sourceInput,
        reconciliationToken: first.reconciliationToken,
      }),
    ).resolves.toEqual({ source: candidate, recovery: "authoritative_readback" });
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET", "GET"]);
  });

  test("retains the same token and never posts when readback finds zero", async () => {
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
      return json({ sources: [] });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    const second = await expectSourceIndeterminate({
      ...sourceInput,
      reconciliationToken: first.reconciliationToken,
    });
    expect(second.reconciliationToken).toEqual(first.reconciliationToken);
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
  });

  test("retains the same token and never posts when readback finds multiple", async () => {
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json({ error: { code: "upstream_failure" } }, 502);
      }
      listReads += 1;
      return json({
        sources:
          listReads === 1
            ? []
            : [sourceRecord({ id: "src_a" }), sourceRecord({ id: "src_b" })],
      });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    expect(first.causeSummary).toEqual({
      category: "http",
      status: 502,
      code: "upstream_failure",
    });
    const second = await expectSourceIndeterminate({
      ...sourceInput,
      reconciliationToken: first.reconciliationToken,
    });
    expect(second.reconciliationToken).toEqual(first.reconciliationToken);
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
  });

  test("retains the same token when readback identity mismatches", async () => {
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
        sources:
          listReads === 1
            ? []
            : [sourceRecord({ url: "https://example.test/other.git" })],
      });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    const second = await expectSourceIndeterminate({
      ...sourceInput,
      reconciliationToken: first.reconciliationToken,
    });
    expect(second.reconciliationToken).toEqual(first.reconciliationToken);
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
  });

  test("retains the same token when authoritative readback fails", async () => {
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
      if (listReads === 1) return json({ sources: [] });
      throw new Error("readback unavailable");
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    const second = await expectSourceIndeterminate({
      ...sourceInput,
      reconciliationToken: first.reconciliationToken,
    });
    expect(second.reconciliationToken).toEqual(first.reconciliationToken);
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
  });

  test("adopts an exact Source after a malformed acknowledgement without replaying", async () => {
    const candidate = sourceRecord();
    let listReads = 0;
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json({ source: candidate, requestId: "malformed" }, 201);
      }
      listReads += 1;
      return json({ sources: listReads <= 2 ? [] : [candidate] });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    await expect(
      createSource({
        ...sourceInput,
        reconciliationToken: first.reconciliationToken,
      }),
    ).resolves.toEqual({ source: candidate, recovery: "authoritative_readback" });
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
  });

  test.each(["disabled", "error"] as const)(
    "does not adopt a newly appeared %s Source",
    async (status) => {
      const candidate = sourceRecord({ status });
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
        return json({ sources: listReads <= 2 ? [] : [candidate] });
      }) as typeof fetch;

      const first = await expectSourceIndeterminate(sourceInput);
      const second = await expectSourceIndeterminate({
        ...sourceInput,
        reconciliationToken: first.reconciliationToken,
      });
      expect(second.reconciliationToken).toEqual(first.reconciliationToken);
      expect(posts).toBe(1);
      expect(listReads).toBe(3);
    },
  );

  test.each(["disabled", "error"] as const)(
    "does not accept an acknowledged %s Source as success",
    async (status) => {
      const candidate = sourceRecord({ status });
      let posts = 0;
      let reads = 0;
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if ((init?.method ?? "GET") === "POST") {
          posts += 1;
          return json({ source: candidate, hookSecret: "hook_secret_once" }, 201);
        }
        reads += 1;
        return json({ sources: [] });
      }) as typeof fetch;

      const error = await expectSourceIndeterminate(sourceInput);
      expect(error.reconciliationToken.baselineIds).toEqual([]);
      expect(posts).toBe(1);
      expect(reads).toBe(2);
    },
  );

  test("does not trust an acknowledged response that reuses a baseline Source id", async () => {
    const existing = sourceRecord({ id: "src_existing" });
    let posts = 0;
    let reads = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        return json({ source: existing, hookSecret: "hook_secret_once" }, 201);
      }
      reads += 1;
      return json({ sources: [existing] });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    const second = await expectSourceIndeterminate({
      ...sourceInput,
      reconciliationToken: first.reconciliationToken,
    });
    expect(second.reconciliationToken).toEqual(first.reconciliationToken);
    expect(posts).toBe(1);
    expect(reads).toBe(3);
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
          { error: { code: "invalid_request", message: "source URL is not allowed" } },
          400,
        );
      }
      reads += 1;
      return json({ sources: [] });
    }) as typeof fetch;

    await expect(createSource(sourceInput)).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      isIndeterminate: false,
    });
    expect(posts).toBe(1);
    expect(reads).toBe(1);
  });

  test("does not dispatch POST when the authoritative baseline fails", async () => {
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") posts += 1;
      throw new Error("baseline unavailable");
    }) as typeof fetch;

    await expect(createSource(sourceInput)).rejects.toMatchObject({
      code: "source_create_baseline_unavailable",
      isIndeterminate: false,
    });
    expect(posts).toBe(0);
  });

  test("does not dispatch POST when baseline pagination is incomplete", async () => {
    let posts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") posts += 1;
      return json({ sources: [], nextCursor: "" });
    }) as typeof fetch;

    await expect(createSource(sourceInput)).rejects.toMatchObject({
      code: "source_create_baseline_unavailable",
      isIndeterminate: false,
    });
    expect(posts).toBe(0);
  });

  test("fails closed when readback pagination is incomplete", async () => {
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
      return listReads === 1
        ? json({ sources: [] })
        : json({ sources: [], nextCursor: "" });
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    const second = await expectSourceIndeterminate({
      ...sourceInput,
      reconciliationToken: first.reconciliationToken,
    });
    expect(second.reconciliationToken).toEqual(first.reconciliationToken);
    expect(posts).toBe(1);
    expect(listReads).toBe(3);
  });

  test("follows every baseline and readback page before deciding", async () => {
    const candidate = sourceRecord();
    let reads = 0;
    const urls: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      urls.push(url);
      if ((init?.method ?? "GET") === "POST") {
        throw new Error("create response lost");
      }
      reads += 1;
      if (reads === 1) return json({ sources: [], nextCursor: "baseline_cursor" });
      if (reads === 2) return json({ sources: [] });
      if (reads === 3) return json({ sources: [], nextCursor: "readback_cursor" });
      if (reads === 4) return json({ sources: [] });
      if (reads === 5) return json({ sources: [], nextCursor: "readback_cursor_2" });
      if (reads === 6) return json({ sources: [candidate] });
      throw new Error(`unexpected source page ${url}`);
    }) as typeof fetch;

    const first = await expectSourceIndeterminate(sourceInput);
    await expect(
      createSource({
        ...sourceInput,
        reconciliationToken: first.reconciliationToken,
      }),
    ).resolves.toEqual({ source: candidate, recovery: "authoritative_readback" });
    expect(reads).toBe(6);
    expect(urls).toContain("/api/v1/sources?workspaceId=workspace_1&limit=100&cursor=baseline_cursor");
    expect(urls).toContain("/api/v1/sources?workspaceId=workspace_1&limit=100&cursor=readback_cursor");
  });

  test("aborts mutation five seconds before one absolute deadline while readback stays alive", async () => {
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let now = 1_000_000;
    const timers: Array<{ delay: number; callback: () => void }> = [];
    Date.now = () => now;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      timers.push({
        delay: Number(delay ?? 0),
        callback: callback as () => void,
      });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    let postSignal: AbortSignal | undefined;
    let baselineSignal: AbortSignal | undefined;
    let readbackSignal: AbortSignal | undefined;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        postSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          postSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (baselineSignal === undefined) baselineSignal = init?.signal;
      else if (readbackSignal === undefined) readbackSignal = init?.signal;
      return json({ sources: [] });
    }) as typeof fetch;
    try {
      const attempt = createSource({
        ...sourceInput,
        deadlineAt: now + 10_000,
      });
      while (postSignal === undefined) await Promise.resolve();
      expect(timers.map(({ delay }) => delay)).toContain(5_000);
      expect(timers.map(({ delay }) => delay)).toContain(10_000);
      timers.find(({ delay }) => delay === 5_000)?.callback();
      await expect(attempt).rejects.toBeInstanceOf(
        SourceCreateIndeterminateError,
      );
      expect(postSignal?.aborted).toBe(true);
      expect(baselineSignal?.aborted).toBe(true);
      expect(readbackSignal?.aborted).toBe(false);
      now += 1;
    } finally {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

function candidate(id: string, overrides: Partial<Capsule> = {}): Capsule {
  return activeCapsule({ id, ...overrides });
}

const sourceInput = {
  workspaceId: "workspace_1",
  name: "service",
  url: "https://example.test/app.git",
  defaultRef: "HEAD",
  defaultPath: ".",
  authConnectionId: "connection_1",
  autoSync: true,
} as const;

async function expectSourceIndeterminate(
  input: Parameters<typeof createSource>[0],
): Promise<SourceCreateIndeterminateError> {
  try {
    await createSource(input);
  } catch (error) {
    if (error instanceof SourceCreateIndeterminateError) return error;
    throw error;
  }
  throw new Error("expected Source create to remain indeterminate");
}

function sourceRecord(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_created",
    workspaceId: "workspace_1",
    name: "service",
    url: "https://example.test/app.git",
    defaultRef: "HEAD",
    defaultPath: ".",
    authConnectionId: "connection_1",
    status: "active",
    autoSync: true,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}
