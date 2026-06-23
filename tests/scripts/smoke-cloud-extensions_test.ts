import { expect, test } from "bun:test";

import {
  CLOUD_EXTENSION_SMOKE_KIND,
  runCloudExtensionSmoke,
  type CloudExtensionSmokeOptions,
} from "../../scripts/smoke-cloud-extensions.ts";

const BASE_OPTIONS: CloudExtensionSmokeOptions = {
  url: "https://app.takosumi.test",
  sessionToken: "sess_test_secret_value",
  authTokenKind: "session",
  sessionTokenSource: "file",
  json: true,
  requireCompatMaterialization: false,
  requireProviderE2E: false,
};

test("cloud extension smoke records redacted pass with a materialization gap", async () => {
  const seenAuth: string[] = [];
  const result = await runCloudExtensionSmoke(
    BASE_OPTIONS,
    async (url, init) => {
      const auth = authorization(init);
      if (auth) seenAuth.push(auth);
      return responseFor(new URL(url).pathname, auth !== undefined);
    },
  );

  expect(result.kind).toBe(CLOUD_EXTENSION_SMOKE_KIND);
  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toEqual([
    "cloudflare_compat_materialization_not_enabled",
  ]);
  expect(seenAuth.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke strict mode fails on compat materialization stub", async () => {
  const result = await runCloudExtensionSmoke(
    { ...BASE_OPTIONS, requireCompatMaterialization: true },
    async (url, init) =>
      responseFor(new URL(url).pathname, authorization(init) !== undefined),
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(
    result.checks.find(
      (check) => check.name === "cloudflareCompatScriptPutAuth",
    )?.ok,
  ).toBe(false);
});

test("cloud extension smoke strict mode passes when compat lifecycle works", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireProviderE2E: true,
    },
    async (url, init) =>
      responseForImplementedCompat(
        new URL(url).pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
      ),
    async () => ({
      status: 200,
      ok: true,
      summary: {
        resource: "cloudflare_r2_bucket",
        completedSteps: ["init", "plan", "apply", "destroy"],
      },
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.gaps).toEqual([]);
  expect(
    result.checks.find(
      (check) => check.name === "cloudflareCompatScriptPutAuth",
    )?.status,
  ).toBe(201);
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke supports PAT auth and provider E2E evidence", async () => {
  const patOptions: CloudExtensionSmokeOptions = {
    ...BASE_OPTIONS,
    sessionToken: "takpat_test_secret_value",
    authTokenKind: "pat",
    requireCompatMaterialization: true,
    requireProviderE2E: true,
  };
  const result = await runCloudExtensionSmoke(
    patOptions,
    async (url, init) =>
      responseForImplementedCompat(
        new URL(url).pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
      ),
    async (options) => ({
      status: 200,
      ok: true,
      summary: {
        resource: "cloudflare_r2_bucket",
        tokenSeenByRunner: options.sessionToken.startsWith("takpat_"),
        completedSteps: ["init", "plan", "apply", "destroy"],
      },
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.authTokenKind).toBe("pat");
  expect(
    result.checks.find((check) => check.name === "cloudExtensionPatAuth")?.ok,
  ).toBe(true);
  expect(
    result.checks.find((check) => check.name === "cloudflareCompatProviderE2E")
      ?.summary,
  ).toMatchObject({
    resource: "cloudflare_r2_bucket",
    completedSteps: ["init", "plan", "apply", "destroy"],
  });
  expect(JSON.stringify(result)).not.toContain(patOptions.sessionToken);
});

function responseFor(pathname: string, authenticated: boolean): Response {
  if (pathname === "/v1/account/session/me") {
    return json({ subject: "tsub_test" });
  }
  if (pathname === "/gateway/ai/v1/models" && !authenticated) {
    return openAiError(401);
  }
  if (pathname === "/gateway/ai/v1/models") {
    return json({
      object: "list",
      data: [{ id: "takosumi/default", object: "model" }],
    });
  }
  if (pathname === "/gateway/ai/v1/chat/completions") {
    return json({ choices: [{ index: 0 }] });
  }
  if (pathname === "/gateway/ai/v1/embeddings") {
    return json({ data: [{ embedding: [0] }] });
  }
  if (
    pathname === "/compat/cloudflare/client/v4/user/tokens/verify" &&
    !authenticated
  ) {
    return cloudflare(false, null, 401, [10000]);
  }
  if (pathname === "/compat/cloudflare/client/v4/user/tokens/verify") {
    return cloudflare(true, { status: "active" });
  }
  if (pathname === "/compat/cloudflare/client/v4/accounts") {
    return cloudflare(true, [{ id: "ts_acc_takosumi_cloud" }]);
  }
  if (pathname.endsWith("/workers/scripts")) {
    return cloudflare(true, []);
  }
  return cloudflare(false, null, 501, [9001]);
}

function responseForImplementedCompat(
  pathname: string,
  method: string,
  authenticated: boolean,
): Response {
  if (!pathname.includes("/workers/scripts/takosumi-smoke")) {
    return responseFor(pathname, authenticated);
  }
  if (method === "PUT") {
    return cloudflare(true, { id: "takosumi-smoke" }, 201);
  }
  if (method === "GET") {
    return cloudflare(true, { id: "takosumi-smoke" });
  }
  if (method === "DELETE") {
    return cloudflare(true, { id: "takosumi-smoke", deleted: true });
  }
  return cloudflare(false, null, 405, [1001]);
}

function authorization(init: RequestInit | undefined): string | undefined {
  return typeof init?.headers === "object" && init.headers !== null
    ? (init.headers as Record<string, string>).authorization
    : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiError(status: number): Response {
  return json({ error: { code: "unauthorized" } }, status);
}

function cloudflare(
  success: boolean,
  result: unknown,
  status = 200,
  errorCodes: readonly number[] = [],
): Response {
  return json(
    {
      success,
      result,
      errors: errorCodes.map((code) => ({ code, message: "redacted" })),
      messages: [],
    },
    status,
  );
}
