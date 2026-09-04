import { expect, test } from "bun:test";

import { OPERATOR_CONTROL_MCP_INSTALL_CONFIG } from "../../../deploy/operator-control-mcp.ts";
import * as hostedWorker from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { composeTakoserverHostedWorkerEnv } from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { deployControlServiceOptions } from "../../../worker/src/deploy_control_seam.ts";

const HOSTED_PROVIDER_CONNECTION_ID = "conn_hostedProvider01";
const HOSTED_PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";

test("Takosumi Hosted composes no application InstallConfigs by default", () => {
  const composed = composeTakoserverHostedWorkerEnv({} as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
});

test("Takosumi Hosted explicitly allows local-exec only in staging", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_STAGING_ALLOW_LOCAL_EXEC: "1",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toHaveLength(1);
  const config = composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION?.[0];
  expect(config?.id).toBe("cfg-default-opentofu-capsule");
  expect(config?.policy).toMatchObject({
    allowedProvisionerTypes: ["local-exec"],
    repositoryInstallUx: {
      allowedOidcScopes: expect.arrayContaining(["openid", "capsules:write"]),
    },
  });
});

test("Takosumi Hosted ignores the local-exec flag outside staging", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_ENVIRONMENT: "production",
    TAKOSUMI_STAGING_ALLOW_LOCAL_EXEC: "1",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
});

test("Takosumi Hosted requires the explicit local-exec staging flag", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_ENVIRONMENT: "staging",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
});

test("Takosumi Hosted rejects malformed or open runner composition before composing", () => {
  expect(() =>
    composeTakoserverHostedWorkerEnv({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {},
    } as never),
  ).toThrow("profiles must be an array");
  expect(() =>
    composeTakoserverHostedWorkerEnv({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [],
        unknown: true,
      },
    } as never),
  ).toThrow("unknown key unknown");
  expect(() =>
    composeTakoserverHostedWorkerEnv({
      TAKOSUMI_ENABLED_RUNNER_PROFILES: "not-configured",
    } as never),
  ).toThrow("unknown runner profile id not-configured");
});

test("Takosumi Hosted projects release-pinned evidence authority into the fetch composition", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
  } as never);

  expect(composed.TAKOSUMI_RUNNER_HOST_COMPOSITION).toMatchObject({
    executionEvidenceAuthority: {
      controllerArtifact: {
        digest: `sha256:${"a".repeat(64)}`,
        immutable: true,
      },
      runnerArtifact: {
        digest: `sha256:${"a".repeat(64)}`,
        immutable: true,
      },
      executorArtifact: {
        digest: `sha256:${"b".repeat(64)}`,
        immutable: true,
      },
    },
  });
});

test("Takosumi Hosted composition is consumable by deploy-control options", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
  } as never);

  const options = deployControlServiceOptions(composed);
  expect(options.runnerProfiles.map((profile) => profile.id)).toEqual([
    "opentofu-default",
  ]);
  expect(options.executionEvidenceAuthority).toEqual(
    composed.TAKOSUMI_RUNNER_HOST_COMPOSITION?.executionEvidenceAuthority,
  );
});

test("Takosumi Hosted refuses a release-pin conflict in an existing composition", () => {
  expect(() =>
    composeTakoserverHostedWorkerEnv({
      TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
      TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
      TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [],
        executionEvidenceAuthority: {
          controllerArtifact: {
            digest: `sha256:${"c".repeat(64)}`,
            immutable: true,
          },
          runnerArtifact: {
            digest: `sha256:${"a".repeat(64)}`,
            immutable: true,
          },
          executorArtifact: {
            digest: `sha256:${"b".repeat(64)}`,
            immutable: true,
          },
        },
      },
    } as never),
  ).toThrow("authority conflicts with release pins");
});

test("Takosumi Hosted RunOwner receives the composed release authority", async () => {
  const rawEnv = {
    TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
  } as never;
  const values = new Map<string, unknown>();
  let alarmAt: number | undefined;
  const storage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async getAlarm() {
      return alarmAt ?? null;
    },
    async setAlarm(value: number) {
      alarmAt = value;
    },
    async deleteAlarm() {
      alarmAt = undefined;
    },
  };
  let dispatchedEnv: unknown;
  const owner = new hostedWorker.OpenTofuRunOwnerObject(
    { storage },
    rawEnv,
    {
      now: () => 0,
      dispatch: (_dispatch, env) => {
        dispatchedEnv = env;
        return Promise.resolve();
      },
      readRunStatus: () => Promise.resolve("succeeded"),
    },
  );

  const response = await owner.fetch(
    new Request("https://run-owner/start", {
      method: "POST",
      body: JSON.stringify({
        kind: "takosumi.opentofu-run-owner.start@v1",
        action: "apply",
        runId: "run_hosted_1",
        workspaceId: "workspace_1",
      }),
    }),
  );
  expect(response.status).toBe(202);
  await owner.alarm();

  const composed = composeTakoserverHostedWorkerEnv(rawEnv);
  expect(dispatchedEnv).toBe(composed);
  expect(deployControlServiceOptions(dispatchedEnv as never).executionEvidenceAuthority).toEqual(
    composed.TAKOSUMI_RUNNER_HOST_COMPOSITION?.executionEvidenceAuthority,
  );
});

test("Takoserver Hosted wrapper preserves every Worker Durable Object export", () => {
  expect(typeof hostedWorker.CoordinationObject).toBe("function");
  expect(typeof hostedWorker.LocalSubstrateOpenTofuRunnerProxyObject).toBe(
    "function",
  );
  expect(typeof hostedWorker.OpenTofuRunOwnerObject).toBe("function");
  expect(typeof hostedWorker.OpenTofuRunnerObject).toBe("function");
});

test("Takoserver Hosted wrapper keeps Worker variables enumerable", () => {
  const controlDb = Object.freeze({ binding: "control" });
  const env = {
    TAKOSUMI_CONTROL_DB: controlDb,
    TAKOSUMI_SECRET_BOUNDARY_KEY: "sealed-runtime-key",
    TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
  } as never;

  const composed = composeTakoserverHostedWorkerEnv(env);

  expect(composed).not.toBe(env);
  expect(Object.entries(composed)).toContainEqual([
    "TAKOSUMI_SECRET_BOUNDARY_KEY",
    "sealed-runtime-key",
  ]);
  expect(composed.TAKOSUMI_CONTROL_DB).toBe(controlDb);
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
  expect(composeTakoserverHostedWorkerEnv(env)).toBe(composed);
});

test("Takoserver Hosted proves only the exact Capsule-scoped OAuth resource", async () => {
  const calls: unknown[] = [];
  const composed = composeTakoserverHostedWorkerEnv({
    HOSTED: {
      async authorizeInterfaceOAuth2Resource(input: unknown) {
        calls.push(input);
        return true;
      },
    },
  } as never);

  await expect(
    composed.TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER?.({
      workspaceId: "workspace_1",
      interfaceId: "interface_1",
      ownerRef: { kind: "Capsule", id: "capsule_1" },
      resource: "https://storage.example.test/mcp",
    }),
  ).resolves.toBe(true);
  expect(calls).toEqual([
    {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      resource: "https://storage.example.test/mcp",
    },
  ]);
  await expect(
    composed.TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER?.({
      workspaceId: "workspace_1",
      interfaceId: "interface_2",
      ownerRef: { kind: "Workspace", id: "workspace_1" },
      resource: "https://storage.example.test/mcp",
    }),
  ).resolves.toBe(false);
  expect(calls).toHaveLength(1);
});

test("Takoserver Hosted composes only the optional operator MCP declaration", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([
    {
      ...OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
      variableMapping: { takosumi_origin: "https://app.takosumi.test" },
    },
  ]);
});

test("Takoserver Hosted composes staging policy and operator MCP declarations", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_STAGING_ALLOW_LOCAL_EXEC: "1",
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toHaveLength(2);
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION?.[0]).toMatchObject({
    id: "cfg-default-opentofu-capsule",
    policy: { allowedProvisionerTypes: ["local-exec"] },
  });
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION?.[1]).toEqual({
    ...OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
    variableMapping: { takosumi_origin: "https://app.takosumi.test" },
  });
});

test("Takoserver Hosted connection descriptor remains publicly discoverable", async () => {
  const response = await hostedWorker.default.fetch(
    new Request("https://app-staging.takosumi.com/.well-known/takosumi"),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          id: "takosumi-hosted-sponsorship",
          basePath: "/api/v1/account/subscription",
          handlerKey: "HOSTED",
          authDelivery: "context",
          ownsPathSubtree: true,
          workspaceContext: "query-required",
          requiredScopes: [],
          capabilities: ["takosumi.account.subscription.v1"],
          runCredential: {
            audience: "takosumi-hosted.takoform.v1",
            requiredScopes: ["takoform.run"],
          },
          providerCredentialBroker: {
            connectionId: HOSTED_PROVIDER_CONNECTION_ID,
            recipeId: "takoserver-takoform-run-v1",
            providerSource: HOSTED_PROVIDER_SOURCE,
            displayName: "Takoserver",
            exchangePath: "/provider-credentials/takoform",
            envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
          },
        },
      ]),
      HOSTED: {
        fetchAuthenticated: async () => new Response("ok"),
      },
    } as never,
  );

  expect(response.status).toBe(200);
  expect((await response.json()).endpoints.extensions).toEqual({
    "takosumi.account.subscription.v1":
      "https://app-staging.takosumi.com/api/v1/account/subscription",
  });
});
