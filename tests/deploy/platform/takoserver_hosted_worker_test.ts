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

// Link the entry in portable Bun without a global compatibility preload.
// Only the unused Cloudflare base is stubbed; RunOwner inheritance, constructor
// and both composers are actual source. Real DO execution is a separate test.
type StorageEntry = typeof import("../../../deploy/platform/storage-staging-entry-worker.ts");
type StorageEnv = import("../../../deploy/platform/storage-staging-profile.ts").StorageStagingEnv;
let storageEntry: Promise<StorageEntry> | undefined;
async function storageProfileEntry(): Promise<StorageEntry> {
  return await (storageEntry ??= (async () => {
    const result = await Bun.build({
      entrypoints: [new URL("../../../deploy/platform/storage-staging-entry-worker.ts", import.meta.url).pathname],
      target: "bun",
      format: "esm",
      plugins: [{
        name: "portable-unused-workers-base",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers", namespace: "portable-workers",
          }));
          build.onLoad({ filter: /.*/, namespace: "portable-workers" }, () => ({
            loader: "js",
            contents: `
              export class WorkerEntrypoint {
                constructor(ctx, env) { this.ctx = ctx; this.env = env; }
              }
              export class DurableObject extends WorkerEntrypoint {}
              export class RpcTarget {}
              export const env = {};
              export function waitUntil() {}
            `,
          }));
        },
      }],
    });
    if (!result.success) throw new AggregateError(result.logs, "portable entry bundle failed");
    const bytes = Buffer.from(await result.outputs[0]!.text());
    return await import(`data:text/javascript;base64,${bytes.toString("base64")}`) as StorageEntry;
  })());
}
function selectedStorageEnv() {
  const unused = async () => { throw new Error("constructor must not call custody"); };
  const usage = {
    readStoredSource: unused,
    readStoredObject: unused,
    prepareStoredObject: unused,
    confirmStoredObject: unused,
    cancelStoredObject: unused,
  };
  return {
    TAKOSUMI_OSS_STORAGE_PROFILE: "stored-service-staging-v1",
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_VERSION_METADATA: { id: "11111111-2222-3333-4444-555555555555" },
    TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}` as const,
    TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}` as const,
    TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"c".repeat(64)}` as const,
    TAKOSUMI_CONTROL_DB: {},
    R2_STATE: {}, R2_ARTIFACTS: {}, R2_SOURCE: {}, R2_BACKUPS: {},
    TAKOSUMI_STORED_SERVICE_USAGE: usage,
    TAKOSUMI_STORED_INVENTORY_FENCES: {},
    TAKOSUMI_STORED_ORIGINAL_OWNERS: { readOriginalStoredObjectOwner: async () => null },
  };
}
test("storage profile RunOwner dispatch receives the same qualified owner composition as its Runner", async () => {
  const entry = await storageProfileEntry();
  const raw = selectedStorageEnv();
  const values = new Map<string, unknown>();
  let received: unknown;
  let calls = 0;
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const owner = new entry.OpenTofuRunOwnerObject({ storage }, raw as never, {
    now: () => 0,
    dispatch: async (_dispatch, env) => {
      calls++;
      received = env;
    },
    readRunStatus: async () => "succeeded",
  });
  const response = await owner.fetch(new Request("https://run-owner/start", {
    method: "POST",
    body: JSON.stringify({
      kind: "takosumi.opentofu-run-owner.start@v1",
      action: "apply", runId: "apply_storage_profile", workspaceId: "workspace_storage_profile",
    }),
  }));
  expect(response.status).toBe(202);
  await owner.alarm();
  expect(calls).toBe(1);
  expect(received).toBe(owner.env);
  const composed = owner.env as StorageEnv;
  expect(composed.TAKOSUMI_STORED_SERVICE_USAGE).toBe(raw.TAKOSUMI_STORED_SERVICE_USAGE);
  expect(composed.TAKOSUMI_STORED_ORIGINAL_OWNERS).toBe(raw.TAKOSUMI_STORED_ORIGINAL_OWNERS);
  expect(typeof composed.TAKOSUMI_STORED_OBJECT_OWNERS?.resolveStoredObjectOwner).toBe("function");
  expect(raw).not.toHaveProperty("TAKOSUMI_STORED_OBJECT_OWNERS");
  const options = deployControlServiceOptions(composed);
  expect(options.runnerProfiles.length).toBeGreaterThan(0);
  expect(options.executionEvidenceAuthority?.controllerArtifact.digest).toBe(raw.TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST);
  expect(options.executionEvidenceAuthority?.runnerArtifact.digest).toBe(raw.TAKOSUMI_RUNNER_ARTIFACT_DIGEST);
  expect(options.executionEvidenceAuthority?.executorArtifact.digest).toBe(raw.TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST);
});
test("storage profile RunOwner refuses missing selector or incomplete graph before dispatch", async () => {
  const entry = await storageProfileEntry();
  const raw = selectedStorageEnv();
  const withoutOwner: Partial<typeof raw> = { ...raw };
  delete withoutOwner.TAKOSUMI_STORED_ORIGINAL_OWNERS;
  const withoutSelector: Partial<typeof raw> = { ...raw };
  delete withoutSelector.TAKOSUMI_OSS_STORAGE_PROFILE;
  for (const invalid of [withoutOwner, withoutSelector, { ...raw, TAKOSUMI_ENVIRONMENT: "production" }]) {
    expect(() => new entry.OpenTofuRunOwnerObject({ storage: {} } as never, invalid as never)).toThrow();
  }
});
