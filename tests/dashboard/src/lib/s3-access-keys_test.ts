import { afterEach, describe, expect, test } from "bun:test";
import {
  createS3CustomerAccessKey,
  listS3CustomerAccessKeys,
  revokeS3CustomerAccessKey,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const metadata = {
  apiVersion: "cloud.takosumi.com/v1",
  id: "sak_123",
  accessKeyId: "AKIA123",
  workspaceId: "ws_1",
  principalId: "user_1",
  label: "backup",
  grants: [
    {
      resourceId: "tkrn:ws_1:ObjectBucket:assets",
      resourceName: "assets",
      interfaceId: "iface_1",
      permission: "storage.read",
    },
  ],
  status: "active",
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
} as const;

describe("S3 customer access key dashboard client", () => {
  test("pages workspace metadata and never requires a secret on list", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      return jsonResponse(
        url.includes("cursor=next")
          ? { accessKeys: [metadata] }
          : { accessKeys: [metadata], nextCursor: "next" },
      );
    }) as typeof fetch;

    await expect(listS3CustomerAccessKeys("ws_1")).resolves.toEqual([
      metadata,
      metadata,
    ]);
    expect(calls).toEqual([
      "/v1/cloud/s3-access-keys?workspaceId=ws_1",
      "/v1/cloud/s3-access-keys?workspaceId=ws_1&cursor=next",
    ]);
  });

  test("creates an exact ObjectBucket grant with idempotency and no caller identity", async () => {
    let request: { readonly url?: string; readonly init?: RequestInit } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = {
        url: typeof input === "string" ? input : String(input),
        init,
      };
      return jsonResponse({
        accessKey: {
          ...metadata,
          credentials: {
            accessKeyId: "AKIA123",
            secretAccessKey: "secret-only-once",
          },
        },
      }, 201);
    }) as typeof fetch;

    const result = await createS3CustomerAccessKey({
      workspaceId: "ws_1",
      resourceId: "tkrn:ws_1:ObjectBucket:assets",
      resourceName: "assets",
      label: "backup",
      permissions: ["storage.read", "storage.list"],
      idempotencyKey: "idem-1",
    });

    expect(result.accessKey.credentials.secretAccessKey).toBe(
      "secret-only-once",
    );
    expect(request.url).toBe(
      "/v1/cloud/s3-access-keys?workspaceId=ws_1",
    );
    expect(request.init?.method).toBe("POST");
    expect(
      new Headers(request.init?.headers).get("idempotency-key"),
    ).toBe("idem-1");
    const body = JSON.parse(String(request.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      label: "backup",
      grants: [
        { resourceName: "assets", permissions: ["storage.read", "storage.list"] },
      ],
    });
    expect(body).not.toHaveProperty("resourceId");
    expect(body).not.toHaveProperty("principalId");
  });

  test("rejects a mismatched canonical resource before making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as typeof fetch;

    await expect(
      createS3CustomerAccessKey({
        workspaceId: "ws_1",
        resourceId: "tkrn:ws_1:ObjectBucket:other",
        resourceName: "assets",
        label: "backup",
        permissions: ["storage.read"],
        idempotencyKey: "idem-1",
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(called).toBe(false);
  });

  test("revokes by workspace and returns metadata only", async () => {
    let url = "";
    let method = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = typeof input === "string" ? input : String(input);
      method = init?.method ?? "";
      return jsonResponse({ accessKey: { ...metadata, status: "revoked" } });
    }) as typeof fetch;

    await expect(revokeS3CustomerAccessKey("ws_1", "sak_123")).resolves.toMatchObject({
      id: "sak_123",
      status: "revoked",
    });
    expect(url).toBe(
      "/v1/cloud/s3-access-keys/sak_123?workspaceId=ws_1",
    );
    expect(method).toBe("DELETE");
  });
});
