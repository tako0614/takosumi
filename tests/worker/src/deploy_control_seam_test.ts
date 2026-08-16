import { expect, test } from "bun:test";
import {
  cachedDeployControlService,
  cachedRunOwnerDeployControlService,
  cachedServiceAttempt,
  deployControlServiceOptions,
} from "../../../worker/src/deploy_control_seam.ts";
import {
  platformResourceCapsuleOwnerResolver,
  TAKOSUMI_INTERNAL_RESOURCE_CAPSULE_OWNER_HEADER,
} from "../../../worker/src/deploy_control_seam.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  createDefaultRunnerProfiles,
  type OpenTofuRunner,
} from "../../../core/domains/deploy-control/mod.ts";

test("actual deploy and RunOwner wrappers evict rejected composition attempts", async () => {
  for (const create of [
    cachedDeployControlService,
    cachedRunOwnerDeployControlService,
  ]) {
    // Force the composition seam to reject before any D1/bootstrap side effect.
    // Both wrappers still exercise their real per-environment cache and retry
    // identity; the generic helper test below covers the underlying factory
    // call count and stale-generation fence.
    const env = {
      TAKOSUMI_RESOURCE_FORM_TRANSITION_HOST: {},
    } as Parameters<typeof create>[0];
    const first = create(env);
    expect(create(env)).toBe(first);
    await expect(first).rejects.toThrow(
      "Resource Form transition host and evidence ports must be composed together",
    );

    const retry = create(env);
    expect(retry).not.toBe(first);
    await expect(retry).rejects.toThrow(
      "Resource Form transition host and evidence ports must be composed together",
    );
  }
});

test("deploy and RunOwner service caches evict rejected attempts but share pending ones", async () => {
  for (const cacheKind of ["deploy", "run-owner"] as const) {
    const cache = new WeakMap<object, Promise<{ readonly generation: number }>>();
    const env = {};
    let attempts = 0;
    let rejectFirst: ((error: unknown) => void) | undefined;
    const firstPending = new Promise<{ readonly generation: number }>(
      (_, reject) => {
        rejectFirst = reject;
      },
    );
    const first = cachedServiceAttempt(cache, env, async () => {
      attempts += 1;
      return await firstPending;
    });
    expect(cachedServiceAttempt(cache, env, async () => ({ generation: 99 }))).toBe(
      first,
    );
    await Promise.resolve();
    expect(attempts).toBe(1);

    rejectFirst!(new Error(`${cacheKind} bootstrap failed`));
    await first.catch((error) => expect(error).toBeInstanceOf(Error));

    const retry = cachedServiceAttempt(cache, env, async () => {
      attempts += 1;
      return { generation: 2 };
    });
    expect(retry).not.toBe(first);
    expect(cachedServiceAttempt(cache, env, async () => ({ generation: 99 }))).toBe(
      retry,
    );
    await expect(retry).resolves.toEqual({ generation: 2 });
    expect(attempts).toBe(2);

    // Simulate a future generation reset racing the stale rejection. The old
    // attempt must not delete the newer cache entry.
    const fencedEnv = {};
    let rejectStale: ((error: unknown) => void) | undefined;
    const stalePending = new Promise<{ readonly generation: number }>(
      (_, reject) => {
        rejectStale = reject;
      },
    );
    const stale = cachedServiceAttempt(cache, fencedEnv, async () => stalePending);
    await Promise.resolve();
    const newer = Promise.resolve({ generation: 3 });
    cache.set(fencedEnv, newer);
    rejectStale!(new Error("stale generation"));
    await stale.catch((error) => expect(error).toBeInstanceOf(Error));
    expect(cache.get(fencedEnv)).toBe(newer);
  }
});

test("Worker composition accepts explicit host RunnerProfiles and executors", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  const privateNetworkRunner = {} as OpenTofuRunner;
  const options = deployControlServiceOptions({
    TAKOSUMI_ENABLED_RUNNER_PROFILES: "private-network,opentofu-default",
    TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID: "private-network",
    TAKOSUMI_RUNNER_HOST_COMPOSITION: {
      profiles: [
        {
          ...reference,
          id: "private-network",
          name: "Private network",
          executorId: "operator.private-network",
          lifecycle: { state: "candidate" },
        },
      ],
      executors: new Map([["operator.private-network", privateNetworkRunner]]),
    },
  } as unknown as CloudflareWorkerEnv);

  expect(options.runnerProfiles.map((profile) => profile.id)).toEqual([
    "private-network",
    "opentofu-default",
  ]);
  expect(options.runnerProfiles[0]?.lifecycle.state).toBe("active");
  expect(options.defaultRunnerProfileId).toBe("private-network");
  expect(options.runnerExecutors?.get("operator.private-network")).toBe(
    privateNetworkRunner,
  );
});

test("Worker composition rejects duplicate built-in profile ids", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: { profiles: [reference] },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("duplicate profile opentofu-default");
});

test("Worker composition rejects a text RunnerProfile catalog", () => {
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: JSON.stringify({ profiles: [] }),
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code runtime object");
});

test("Worker composition accepts only a host-code Interface OAuth resource authorizer", async () => {
  const authorizer = async () => true;
  const options = deployControlServiceOptions({
    TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER: authorizer,
  } as unknown as CloudflareWorkerEnv);
  expect(options.interfaceOAuth2ResourceAuthorizer).toBe(authorizer);
  await expect(
    options.interfaceOAuth2ResourceAuthorizer!({
      workspaceId: "workspace_1",
      interfaceId: "interface_1",
      ownerRef: { kind: "Resource", id: "tkrn:workspace_1:KVStore:cache" },
      resource: "https://app.takosumi.com/v1/cloud/resources",
    }),
  ).resolves.toBeTrue();

  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER: "true",
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code function");
});

test("Worker composition mounts ledger HTTP routes only for explicit private ingress", () => {
  expect(
    deployControlServiceOptions({} as unknown as CloudflareWorkerEnv)
      .mountInternalLedgerRoutes,
  ).toBeUndefined();
  expect(
    deployControlServiceOptions({
      LOCAL_SUBSTRATE_TEST_BED: "1",
    } as unknown as CloudflareWorkerEnv).mountInternalLedgerRoutes,
  ).toBe(true);
  expect(
    deployControlServiceOptions({
      TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1",
    } as unknown as CloudflareWorkerEnv).mountInternalLedgerRoutes,
  ).toBe(true);
});

test("Worker composes exact Form transition host/evidence ports only as code", () => {
  const host = { dispatch: async () => ({ status: "rejected", code: "test" }), readback: async () => ({ status: "absent" }) };
  const evidence = { authorize: async () => true };
  const options = deployControlServiceOptions({
    TAKOSUMI_RESOURCE_FORM_TRANSITION_HOST: host,
    TAKOSUMI_RESOURCE_FORM_TRANSITION_EVIDENCE: evidence,
  } as unknown as CloudflareWorkerEnv);
  expect(options.resourceFormTransitionHost).toBe(host);
  expect(options.resourceFormTransitionEvidence).toBe(evidence);
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RESOURCE_FORM_TRANSITION_HOST: host,
    } as unknown as CloudflareWorkerEnv)
  ).toThrow("must be composed together");
});

test("legacy managed-provider headers cannot manufacture Capsule ownership", async () => {
  const resolver = platformResourceCapsuleOwnerResolver(
    {} as unknown as CloudflareWorkerEnv,
  );

  await expect(
    resolver({
      actor: {
        actorAccountId: "principal_1",
        workspaceId: "workspace_1",
        roles: ["owner"],
        scopes: ["resources:*"],
        requestId: "request_1",
      },
      request: new Request("https://app.takosumi.test/resources", {
        headers: {
          "x-takosumi-internal-managed-provider-run-token": "legacy-token",
          "x-takosumi-internal-managed-provider-profile": "legacy-profile",
        },
      }),
      space: "workspace_1",
      kind: "ObjectBucket",
      name: "assets",
    }),
  ).resolves.toBeUndefined();
});

test("only the trusted internal Run bridge resolves exact Capsule ownership", async () => {
  const resolver = platformResourceCapsuleOwnerResolver(
    {} as unknown as CloudflareWorkerEnv,
  );
  const owner = {
    kind: "Capsule",
    id: "capsule_1",
    workspaceId: "workspace_1",
    installingPrincipalId: "principal_1",
  } as const;
  await expect(
    resolver({
      actor: {
        actorAccountId: "principal_1",
        workspaceId: "workspace_1",
        roles: ["operator"],
        requestId: "request_1",
      },
      request: new Request("https://app.takosumi.test/resources", {
        headers: {
          [TAKOSUMI_INTERNAL_RESOURCE_CAPSULE_OWNER_HEADER]:
            JSON.stringify(owner),
        },
      }),
      space: "workspace_1",
      kind: "RelationalDatabase",
      name: "database",
    }),
  ).resolves.toEqual(owner);

  await expect(
    resolver({
      actor: {
        actorAccountId: "principal_other",
        workspaceId: "workspace_1",
        roles: ["operator"],
        requestId: "request_2",
      },
      request: new Request("https://app.takosumi.test/resources", {
        headers: {
          [TAKOSUMI_INTERNAL_RESOURCE_CAPSULE_OWNER_HEADER]:
            JSON.stringify(owner),
        },
      }),
      space: "workspace_1",
      kind: "RelationalDatabase",
      name: "database",
    }),
  ).rejects.toThrow("owner authority is invalid");
});
