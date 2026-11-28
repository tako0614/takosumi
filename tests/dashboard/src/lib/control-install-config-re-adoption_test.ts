import { afterEach, expect, jest, test } from "bun:test";
import { createCapsuleInstallConfigReAdoption, getCapsuleInstallConfigReAdoptionContext } from "../../../../dashboard/src/lib/control-api.ts";
import type { CreateCapsuleInstallConfigReAdoptionRequest } from "takosumi-contract";
import { reAdoptionContext } from "../../fixtures/re-adoption-context.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const request: CreateCapsuleInstallConfigReAdoptionRequest = {
  sourceSnapshotId: "snapshot_target",
  reason: "Review target version inputs",
  reviewedUserVariables: { release_note: "fixture-value", optional_flag: false },
  expected: { authorityGuard: "fixture-current-opaque-guard" },
};
const receipt = (replayed: boolean) => ({
  capsule: { id: "capsule_a", installConfigId: "config_target" },
  installConfigReAdoption: {
    replayed, previousInstallConfigId: "config_current", previousInstallConfigDigest: "fixture-current-digest",
    targetInstallConfigId: "config_target", targetInstallConfigDigest: "fixture-target-digest", sourceSnapshotId: "snapshot_target",
  },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

test("re-adoption transports the explicit complete user set and current opaque guard once", async () => {
  const calls: Array<{ path: string; method: string; key: string | null; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method ?? "GET",
      key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
    return json(receipt(false));
  }) as typeof fetch;
  expect(await createCapsuleInstallConfigReAdoption("capsule_a", request, "fixture-re-adopt-key")).toEqual(receipt(false));
  expect(calls).toEqual([{ path: "/api/v1/capsules/capsule_a/install-config-re-adoptions", method: "POST", key: "fixture-re-adopt-key", body: request }]);
  expect((calls[0]!.body as Record<string, unknown>).baseInstallConfigId).toBeUndefined();
});

test("lost re-adoption ACK is not retried automatically and explicit replay preserves request and key", async () => {
  const calls: Array<{ key: string | null; body: unknown }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
    if (calls.length === 1) throw new Error("fixture ACK lost after commit");
    return json(receipt(true));
  }) as typeof fetch;
  await expect(createCapsuleInstallConfigReAdoption("capsule_a", request, "fixture-re-adopt-key")).rejects.toThrow("fixture ACK lost after commit");
  expect(calls).toHaveLength(1);
  expect((await createCapsuleInstallConfigReAdoption("capsule_a", request, "fixture-re-adopt-key")).installConfigReAdoption.replayed).toBe(true);
  expect(calls).toEqual([{ key: "fixture-re-adopt-key", body: request }, { key: "fixture-re-adopt-key", body: request }]);
});

test("stale or refused re-adoption retains the server error without another mutation", async () => {
  for (const [status, code] of [[409, "failed_precondition"], [403, "app_access_denied"]] as const) {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json({ error: { code, message: "fixture refusal" } }, status); }) as typeof fetch;
    await expect(createCapsuleInstallConfigReAdoption("capsule_a", request, "fixture-re-adopt-key")).rejects.toMatchObject({ status, code });
    expect(calls).toBe(1);
  }
});

test.each(["read", "submit"] as const)("re-adoption %s bounds an incomplete JSON body", async (operation) => {
  jest.useFakeTimers();
  const calls: Array<AbortSignal | undefined | null> = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, options?: RequestInit) => {
    calls.push(options?.signal);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode("{"));
      },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const pending: Promise<unknown> = operation === "read"
      ? getCapsuleInstallConfigReAdoptionContext("capsule_a", "revision_failed")
      : createCapsuleInstallConfigReAdoption("capsule_a", request, "fixture-key");
    const outcome = pending.catch((cause: unknown) => cause);
    expect(calls).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
    await Promise.resolve();
    jest.advanceTimersByTime(30_000);
    expect(await outcome).toMatchObject({ status: 0, code: "request_timeout" });
    expect(calls[0]?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  } finally {
    stream?.close();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("target input context is one exact read and malformed ownership never becomes fields", async () => {
  const context = reAdoptionContext();
  const calls: Array<{ path: string; method: string }> = [];
  let value: unknown = context;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method ?? "GET" });
    return json({ installConfigReAdoptionContext: value });
  }) as typeof fetch;
  expect(await getCapsuleInstallConfigReAdoptionContext("capsule_a", "revision_failed")).toEqual(context);
  expect(calls).toEqual([{ path: "/api/v1/capsules/capsule_a/install-config-re-adoption-context?revisionPlanId=revision_failed", method: "GET" }]);
  const poisons: Array<(input: Record<string, unknown>) => void> = [
    input => { input.capsuleId = "other_app"; },
    input => { input.revisionPlanId = "other_revision"; },
    input => { input.authorityGuard = ""; },
    input => { input.currentStateGeneration = -1; },
    input => { input.blockedReason = "unknown_reason"; },
    input => { (input.variables as Array<Record<string, unknown>>)[0]!.userEditable = false; },
    input => { (input.variables as Array<Record<string, unknown>>)[0]!.sensitive = true; },
    input => { (input.variables as Array<Record<string, unknown>>)[0]!.type = "unknown"; },
    input => { (input.variables as Array<Record<string, unknown>>)[0]!.currentValue = { status: "unknown" }; },
    input => { (input.variables as Array<Record<string, unknown>>)[0]!.currentValue = { status: "present" }; },
    input => { const rows = input.variables as unknown[]; rows.push(rows[0]); },
  ];
  for (const poison of poisons) {
    const bad = structuredClone(context) as unknown as Record<string, unknown>;
    poison(bad);
    value = bad;
    await expect(getCapsuleInstallConfigReAdoptionContext("capsule_a", "revision_failed")).rejects.toMatchObject({ code: "invalid_re_adoption_context" });
  }
  expect(calls.every(call => call.method === "GET")).toBe(true);
});
