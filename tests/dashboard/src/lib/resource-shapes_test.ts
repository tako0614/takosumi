import { afterEach, describe, expect, test } from "bun:test";
import {
  applyResourceShape,
  deleteResourceSpacePolicy,
  deleteResourceShape,
  getResourceSpacePolicy,
  listResourceSpacePolicies,
  listResourceShapes,
  previewResourceShape,
  putResourceSpacePolicy,
  putResourceTargetPool,
  type ResourceShapeWriteInput,
} from "../../../../dashboard/src/lib/control-api.ts";
import {
  parseJsonObjectText,
  parseStringMapText,
  resourceOutputKeys,
  resourcePhaseTone,
  resourceShapeHref,
} from "../../../../dashboard/src/lib/resource-shapes.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Resource Shape dashboard client", () => {
  test("keeps Workspace authorization and Resource Space selectors on list reads", async () => {
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
      return jsonResponse({ resources: [] });
    }) as typeof fetch;

    expect(await listResourceShapes("workspace_1", "workspace_1")).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/v1/resources?workspaceId=workspace_1&space=workspace_1",
    );
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  test("previews and applies the exact same typed manifest body", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    const resource = {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "ObjectBucket",
      metadata: {
        name: "assets/main",
        space: "workspace_1",
        managedBy: "opentofu",
      },
      spec: { name: "assets/main", interfaces: ["s3_api"] },
      status: { phase: "Ready", observedGeneration: 1 },
    };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        url: typeof input === "string" ? input : String(input),
        ...(init ? { init } : {}),
      });
      return calls.length === 1
        ? jsonResponse({
            resource,
            selectedImplementation: "s3-compatible",
            selectedTarget: "storage-main",
            portability: "portable",
            nativeResourcePlan: [{ type: "bucket", id: "assets/main" }],
            riskNotes: [],
            summary: "create one bucket",
            planDigest: "sha256:plan",
            specDigest: "sha256:spec",
            resolutionFingerprint: "sha256:resolution",
            quote: {
              quoteId: "quote_1",
              quoteDigest: "sha256:quote",
              planDigest: "sha256:plan",
              specDigest: "sha256:spec",
              resolutionFingerprint: "sha256:resolution",
              ratingStatus: "rated",
              currency: "USD",
              lineItems: [],
              estimatedTotalUsdMicros: 250000,
              expiresAt: "2026-07-14T01:00:00Z",
            },
          })
        : jsonResponse({
            id: "tkrn:workspace_1:ObjectBucket:assets/main",
            ...resource,
          });
    }) as typeof fetch;

    const input: ResourceShapeWriteInput = {
      workspaceId: "workspace_1",
      space: "workspace_1",
      kind: "ObjectBucket",
      name: "assets/main",
      project: "media",
      environment: "production",
      labels: { owner: "media" },
      targetPoolName: "storage",
      spacePolicyName: "default",
      spec: { name: "assets/main", interfaces: ["s3_api"] },
    };
    const preview = await previewResourceShape(input);
    await applyResourceShape(input, {
      planDigest: preview.planDigest,
      quoteId: preview.quote?.quoteId,
      quoteDigest: preview.quote?.quoteDigest,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "/v1/resources/preview",
      "/v1/resources/ObjectBucket/assets%2Fmain",
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual(["POST", "PUT"]);
    const expectedBody = {
      workspaceId: "workspace_1",
      kind: "ObjectBucket",
      metadata: {
        name: "assets/main",
        space: "workspace_1",
        project: "media",
        environment: "production",
        labels: { owner: "media" },
      },
      spec: { name: "assets/main", interfaces: ["s3_api"] },
      targetPoolName: "storage",
      spacePolicyName: "default",
    };
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(expectedBody);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      ...expectedBody,
      review: {
        planDigest: "sha256:plan",
        quoteId: "quote_1",
        quoteDigest: "sha256:quote",
      },
    });
  });

  test("never exposes force delete and scopes operator configuration writes", async () => {
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
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ id: "record_1" });
    }) as typeof fetch;

    await deleteResourceShape("workspace_1", "workspace_1", "Queue", "jobs");
    await putResourceTargetPool({
      workspaceId: "workspace_1",
      space: "workspace_1",
      name: "default",
      spec: { targets: [] },
    });
    await putResourceSpacePolicy({
      workspaceId: "workspace_1",
      space: "workspace_1",
      name: "default",
      spec: { approvals: { requireForApply: true, requireForDestroy: true } },
    });

    expect(calls[0]?.url).toBe(
      "/v1/resources/Queue/jobs?workspaceId=workspace_1&space=workspace_1",
    );
    expect(calls[0]?.url).not.toContain("force");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      workspaceId: "workspace_1",
      space: "workspace_1",
      spec: { targets: [] },
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      workspaceId: "workspace_1",
      space: "workspace_1",
      spec: { approvals: { requireForApply: true, requireForDestroy: true } },
    });
  });

  test("discovers, reads, and deletes SpacePolicies in the selected Workspace and Space", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("cursor=next")) {
        return jsonResponse({
          spacePolicies: [{ id: "policy_2", name: "strict" }],
        });
      }
      if (url.includes("/space-policies/default?")) {
        return jsonResponse({ id: "policy_1", name: "default", spec: {} });
      }
      return jsonResponse({
        spacePolicies: [{ id: "policy_1", name: "default" }],
        nextCursor: "next",
      });
    }) as typeof fetch;

    expect(
      (await listResourceSpacePolicies("workspace_1", "space_1")).map(
        (policy) => policy.name,
      ),
    ).toEqual(["default", "strict"]);
    expect(
      await getResourceSpacePolicy("workspace_1", "space_1", "default"),
    ).toMatchObject({ id: "policy_1", name: "default" });
    await deleteResourceSpacePolicy("workspace_1", "space_1", "strict");

    expect(calls.map((call) => call.url)).toEqual([
      "/v1/space-policies?workspaceId=workspace_1&space=space_1",
      "/v1/space-policies?workspaceId=workspace_1&space=space_1&cursor=next",
      "/v1/space-policies/default?workspaceId=workspace_1&space=space_1",
      "/v1/space-policies/strict?workspaceId=workspace_1&space=space_1",
    ]);
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
  });
});

describe("Resource Shape dashboard helpers", () => {
  test("accepts only JSON objects and string-valued labels", () => {
    expect(parseJsonObjectText('{"name":"assets"}')).toEqual({
      ok: true,
      value: { name: "assets" },
    });
    expect(parseJsonObjectText("[]").ok).toBe(false);
    expect(parseStringMapText('{"owner":"media"}')).toEqual({
      ok: true,
      value: { owner: "media" },
    });
    expect(parseStringMapText('{"priority":1}').ok).toBe(false);
  });

  test("encodes detail links, status tones, and hides output values", () => {
    const resource = {
      apiVersion: "takosumi.dev/v1alpha1" as const,
      kind: "ObjectBucket",
      metadata: {
        name: "assets/main",
        space: "workspace_1",
        managedBy: "opentofu",
      },
      spec: { name: "assets/main" },
      status: {
        phase: "Ready" as const,
        observedGeneration: 1,
        outputs: {
          secretLookingValue: "never-render-this",
          endpoint: "https://example.test",
        },
      },
    };
    expect(resourceShapeHref(resource)).toBe(
      "/resources/ObjectBucket/assets%2Fmain",
    );
    expect(resourcePhaseTone("Ready")).toBe("ok");
    expect(resourcePhaseTone("Failed")).toBe("danger");
    expect(resourceOutputKeys(resource)).toEqual([
      "endpoint",
      "secretLookingValue",
    ]);
  });
});
