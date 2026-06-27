import { expect, test } from "bun:test";

import {
  DEFAULT_CLOUD_EXTENSION_TEST_PREFIXES,
  resolveOptions,
  runCloudExtensionTestResourceCleanup,
} from "../../scripts/cleanup-cloud-extension-test-resources.ts";

const BASE_ENV = {
  TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-secret",
} as const;

test("cloud extension cleanup resolves dry-run defaults without exposing token", async () => {
  const options = await resolveOptions({ prefix: [], json: true }, BASE_ENV);

  expect(options.url).toBe("https://app.takosumi.com");
  expect(options.accountId).toBe("ts_acc_takosumi_cloud");
  expect(options.zoneId).toBe("zone_takosumi_cloud");
  expect(options.write).toBe(false);
  expect(options.verifyAfterWrite).toBe(true);
  expect(options.prefixes).toEqual([...DEFAULT_CLOUD_EXTENSION_TEST_PREFIXES]);
});

test("cloud extension cleanup dry-run lists only public compat test resources", async () => {
  const requests: { readonly method: string; readonly pathname: string }[] = [];
  const options = await resolveOptions(
    {
      prefix: [],
      url: "https://app.takosumi.test",
      sessionToken: "session-secret",
      json: true,
    },
    {},
  );

  const result = await runCloudExtensionTestResourceCleanup(
    options,
    async (url, init) => {
      const parsed = new URL(url);
      requests.push({
        method: init?.method ?? "GET",
        pathname: parsed.pathname,
      });
      return responseForCleanupList(parsed.pathname);
    },
  );

  expect(result.status).toBe("passed");
  expect(result.mode).toBe("dry_run");
  expect(result.totals.candidates).toBe(7);
  expect(result.totals.remainingCandidates).toBe(7);
  expect(result.totals.deleted).toBe(0);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(JSON.stringify(result)).not.toContain(options.sessionToken);
  expect(JSON.stringify(result)).not.toContain("workers_for_platforms");
  expect(
    result.collections
      .flatMap((collection) => collection.candidates)
      .map((candidate) => candidate.name)
      .sort(),
  ).toEqual([
    "takosumi-e2e-route.example/*",
    "takosumi-e2e-worker-api",
    "takosumi-rest-d1-alpha",
    "takosumi-rest-kv-alpha",
    "takosumi-rest-queue-alpha",
    "takosumi-rest-r2-alpha",
    "takosumi-rest-workflow-alpha",
  ]);
});

test("cloud extension cleanup write deletes matched candidates by public resource path", async () => {
  const requests: { readonly method: string; readonly pathname: string }[] = [];
  const options = await resolveOptions(
    {
      prefix: ["takosumi-rest-"],
      url: "https://app.takosumi.test",
      sessionToken: "session-secret",
      write: true,
      verifyAfterWrite: false,
      json: true,
    },
    {},
  );

  const result = await runCloudExtensionTestResourceCleanup(
    options,
    async (url, init) => {
      const parsed = new URL(url);
      requests.push({
        method: init?.method ?? "GET",
        pathname: parsed.pathname,
      });
      if ((init?.method ?? "GET") === "DELETE") {
        return cloudflare(true, { deleted: true });
      }
      return responseForCleanupList(parsed.pathname);
    },
  );

  expect(result.status).toBe("passed");
  expect(result.mode).toBe("write");
  expect(result.totals.candidates).toBe(5);
  expect(result.totals.deleted).toBe(5);
  expect(result.totals.remainingCandidates).toBe(0);
  expect(
    requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.pathname)
      .sort(),
  ).toEqual([
    "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/d1/database/d1_alpha",
    "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/queues/queue_alpha",
    "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/r2/buckets/takosumi-rest-r2-alpha",
    "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/storage/kv/namespaces/kv_alpha",
    "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/workflows/takosumi-rest-workflow-alpha",
  ]);
});

test("cloud extension cleanup write fails when post-write verification still sees candidates", async () => {
  const options = await resolveOptions(
    {
      prefix: ["takosumi-rest-"],
      url: "https://app.takosumi.test",
      sessionToken: "session-secret",
      write: true,
      json: true,
    },
    {},
  );

  const result = await runCloudExtensionTestResourceCleanup(
    options,
    async (url, init) => {
      if ((init?.method ?? "GET") === "DELETE") {
        return cloudflare(true, { deleted: true });
      }
      return responseForCleanupList(new URL(url).pathname);
    },
  );

  expect(result.status).toBe("failed");
  expect(result.totals.deleted).toBe(5);
  expect(result.totals.remainingCandidates).toBe(5);
  expect(result.postWriteVerification?.candidates).toBe(5);
});

function responseForCleanupList(pathname: string): Response {
  if (pathname.endsWith("/storage/kv/namespaces")) {
    return cloudflare(true, [
      { id: "kv_alpha", title: "takosumi-rest-kv-alpha" },
      { id: "kv_user", title: "customer-kv" },
    ]);
  }
  if (pathname.endsWith("/r2/buckets")) {
    return cloudflare(true, [
      { name: "takosumi-rest-r2-alpha" },
      { name: "customer-r2" },
    ]);
  }
  if (pathname.endsWith("/d1/database")) {
    return cloudflare(true, [
      { uuid: "d1_alpha", name: "takosumi-rest-d1-alpha" },
      { uuid: "d1_user", name: "customer-d1" },
    ]);
  }
  if (pathname.endsWith("/queues")) {
    return cloudflare(true, [
      { id: "queue_alpha", queue_name: "takosumi-rest-queue-alpha" },
      { id: "queue_user", queue_name: "customer-queue" },
    ]);
  }
  if (pathname.endsWith("/workflows")) {
    return cloudflare(true, [
      {
        id: "workflow_alpha",
        workflow_name: "takosumi-rest-workflow-alpha",
      },
      { id: "workflow_user", workflow_name: "customer-workflow" },
    ]);
  }
  if (pathname.endsWith("/workers/scripts")) {
    return cloudflare(true, [
      { script_name: "takosumi-e2e-worker-api" },
      { script_name: "customer-worker" },
    ]);
  }
  if (pathname.endsWith("/workers/routes")) {
    return cloudflare(true, [
      { id: "route_alpha", pattern: "takosumi-e2e-route.example/*" },
      { id: "route_user", pattern: "customer.example/*" },
    ]);
  }
  return cloudflare(false, null, 404, [7003]);
}

function cloudflare(
  success: boolean,
  result: unknown,
  status = 200,
  errorCodes: readonly (string | number)[] = [],
): Response {
  return new Response(
    JSON.stringify({
      success,
      result,
      errors: errorCodes.map((code) => ({ code, message: "redacted" })),
      messages: [],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}
