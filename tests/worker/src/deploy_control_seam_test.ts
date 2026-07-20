import { expect, test } from "bun:test";
import { deployControlServiceOptions } from "../../../worker/src/deploy_control_seam.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  createDefaultRunnerProfiles,
  type OpenTofuRunner,
} from "../../../core/domains/deploy-control/mod.ts";

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
