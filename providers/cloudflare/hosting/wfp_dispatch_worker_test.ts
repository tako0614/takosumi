import assert from "node:assert/strict";
import { test } from "bun:test";
import type {
  WorkersForPlatformsDispatchContext,
  WorkersForPlatformsDispatchNamespace,
  WorkersForPlatformsDispatchOptions,
  WorkersForPlatformsUserWorker,
} from "../../../worker/src/bindings.ts";
import {
  createCloudflareWfpDispatchWorker,
  requestForUserWorker,
  tenantScriptNameFromUrl,
} from "./wfp_dispatch_worker.ts";

test("WfP dispatch worker routes the first path segment to the user Worker", async () => {
  const calls: Request[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const worker = createCloudflareWfpDispatchWorker();
  const response = await worker.fetch(
    new Request("https://tenant.example/space-a/path?q=1", {
      headers: {
        "x-takosumi-internal-auth": "operator-secret",
        "x-user-header": "ok",
      },
    }),
    { TAKOSUMI_TENANT_DISPATCH: dispatchNamespace(calls, dispatchCalls) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scriptName: "space-a" });
  assert.deepEqual(dispatchCalls, [{ scriptName: "space-a" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://tenant.example/space-a/path?q=1");
  assert.equal(calls[0].headers.get("x-user-header"), "ok");
  assert.equal(calls[0].headers.has("x-takosumi-internal-auth"), false);
  assert.equal(calls[0].headers.get("x-takosumi-tenant-worker"), "space-a");
  assert.equal(
    calls[0].headers.get("x-takosumi-dispatch-runtime"),
    "cloudflare-workers-for-platforms",
  );
});

test("WfP dispatch worker does not claim egress policy enforcement", async () => {
  const calls: Request[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const worker = createCloudflareWfpDispatchWorker();

  const response = await worker.fetch(
    new Request("https://tenant.example/space-a/egress"),
    { TAKOSUMI_TENANT_DISPATCH: dispatchNamespace(calls, dispatchCalls) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(dispatchCalls, [{ scriptName: "space-a" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.has("x-takosumi-egress-allowlist"), false);
  assert.equal(calls[0].headers.has("x-takosumi-network-policy"), false);
});

test("WfP dispatch worker rejects missing or invalid tenant script names", async () => {
  const worker = createCloudflareWfpDispatchWorker();
  const env = { TAKOSUMI_TENANT_DISPATCH: dispatchNamespace([]) };

  assert.equal(
    (await worker.fetch(new Request("https://tenant.example/"), env)).status,
    404,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://tenant.example/_operator/path"),
        env,
      )
    ).status,
    404,
  );
});

test("requestForUserWorker scrubs operator-only headers before dispatch", () => {
  const forwarded = requestForUserWorker(
    new Request("https://tenant.example/space-a", {
      headers: {
        authorization: "Bearer user-token",
        "x-takosumi-deploy-control-token": "operator-token",
        "x-takosumi-provider-credential": "provider-token",
        "x-takosumi-state-backend-credential": "state-token",
        "x-takosumi-secret-ref": "secret://operator",
        "x-takosumi-operator-secret": "operator-secret",
      },
    }),
    "space-a",
  );

  assert.equal(forwarded.headers.get("authorization"), "Bearer user-token");
  assert.equal(forwarded.headers.has("x-takosumi-deploy-control-token"), false);
  assert.equal(forwarded.headers.has("x-takosumi-provider-credential"), false);
  assert.equal(
    forwarded.headers.has("x-takosumi-state-backend-credential"),
    false,
  );
  assert.equal(forwarded.headers.has("x-takosumi-secret-ref"), false);
  assert.equal(forwarded.headers.has("x-takosumi-operator-secret"), false);
});

test("tenantScriptNameFromUrl accepts only simple lower-case names", () => {
  assert.equal(
    tenantScriptNameFromUrl(new URL("https://tenant.example/space-a")),
    "space-a",
  );
  assert.equal(
    tenantScriptNameFromUrl(new URL("https://tenant.example/Space-A")),
    undefined,
  );
  assert.equal(
    tenantScriptNameFromUrl(new URL("https://tenant.example/-space-a")),
    undefined,
  );
});

interface DispatchCall {
  readonly scriptName: string;
  readonly options?: WorkersForPlatformsDispatchOptions;
  readonly context?: WorkersForPlatformsDispatchContext;
}

function dispatchNamespace(
  calls: Request[],
  dispatchCalls: DispatchCall[] = [],
): WorkersForPlatformsDispatchNamespace {
  return {
    get(
      scriptName: string,
      options?: WorkersForPlatformsDispatchOptions,
      context?: WorkersForPlatformsDispatchContext,
    ): WorkersForPlatformsUserWorker {
      dispatchCalls.push(
        options === undefined && context === undefined
          ? { scriptName }
          : { scriptName, options, context },
      );
      return {
        async fetch(request: Request): Promise<Response> {
          calls.push(request);
          return Response.json({ scriptName });
        },
      };
    },
  };
}
