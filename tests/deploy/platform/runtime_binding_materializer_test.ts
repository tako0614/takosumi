import { describe, expect, test } from "bun:test";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { OidcClientRecord } from "../../../accounts/service/src/store.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import { validateOidcLiveGrant } from "../../../accounts/service/src/oidc-live-grant.ts";
import {
  createTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingControlLedger,
} from "../../../deploy/platform/runtime_binding_materializer.ts";
import {
  createTakosumiAccountsOidcModuleVariableMaterializer,
  type AccountsOidcModuleVariableControlLedger,
} from "../../../deploy/platform/accounts_oidc_module_variable_materializer.ts";
import { TAKOSERVER_HOSTED_INSTALL_CONFIGS } from "../../../deploy/platform/takoserver_hosted_install_configs.ts";
import { composeTakosInstallConfig } from "../../../deploy/platform/takos_install_config.ts";
import type { ResolvedCapsuleProviderBinding } from "../../../core/domains/connections/mod.ts";
import {
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
} from "../../../providers/cloudflare/credentials.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

function installConfig(
  overrides: Partial<InstallConfig> = {},
): InstallConfig {
  return {
    id: "icfg_yurucommu",
    workspaceId: "ws_1",
    name: "Yurucommu",
    variableMapping: {},
    installExperience: {
      projections: [
        {
          kind: "oidc_client",
          variables: {},
          callbackPath: "/api/auth/callback/takos",
          scopes: ["openid", "profile", "email"],
        },
      ],
    },
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [
        {
          binding: "ENCRYPTION_KEY",
          bytes: 32,
          encoding: "hex",
        },
      ],
      oidcClient: {
        issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile", "email"],
      },
    },
    outputAllowlist: {},
    policy: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as InstallConfig;
}

function control(
  config: InstallConfig = installConfig(),
): RuntimeBindingControlLedger {
  return {
    async resolveContext(request) {
      return {
        ok: true,
        context: {
          workspaceId: "ws_1",
          capsuleId: "cap_1",
          runId: "run_1",
          installingPrincipalId: "tsub_owner",
          phase: request.phase,
          lifecycleIntent: request.phase === "destroy"
            ? "destroy"
            : "provision",
        },
      };
    },
    async getCapsule() {
      return {
        id: "cap_1",
        workspaceId: "ws_1",
        name: "Yurucommu",
        installConfigId: "icfg_yurucommu",
      };
    },
    async getInstallConfig() {
      return config;
    },
  };
}

describe("Takosumi runtime binding materializer", () => {
  test("derives the exact DB-owned binding values without a write-capable port in every provider phase", async () => {
    const config = installConfig();
    const original = structuredClone(config);
    const materializer = createTakosumiRuntimeBindingMaterializer({
      control: control(config),
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      derivationKey: "runtime-secret-with-at-least-32-bytes",
    });

    const bindings = [
      "ENCRYPTION_KEY",
      "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
    ] as const;
    const outcomes = await Promise.all(
      (["plan", "apply", "destroy"] as const).map((phase) =>
        materializer.materializeRuntimeBindings({
          request: {
            contract: "takosumi.runtime-bindings/v1",
            workspaceId: "ws_1",
            capsuleId: "cap_1",
            runId: "run_1",
            phase,
          },
          resourceName: "takoform_worker_version.yurucommu",
          scriptName: "yurucommu",
          publicOrigin: "https://yurucommu.example.test",
          bindings,
        })
      ),
    );
    const first = outcomes[0]!;
    const replays = outcomes.slice(1);

    expect(Object.keys(first.values).sort()).toEqual([...bindings].sort());
    expect(first.values.ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/u);
    expect(replays.every((result) =>
      JSON.stringify(result.values) === JSON.stringify(first.values)
    )).toBe(true);
    expect(first.values.TAKOSUMI_ACCOUNTS_ISSUER_URL).toBe(
      "https://app.takosumi.com",
    );
    expect(first.values.TAKOSUMI_ACCOUNTS_REDIRECT_URI).toBe(
      "https://yurucommu.example.test/api/auth/callback/takos",
    );
    expect(first.values.TAKOSUMI_ACCOUNTS_CLIENT_ID).toMatch(
      /^tko_[A-Za-z0-9_-]{43}$/u,
    );
    expect(first.values.TAKOSUMI_ACCOUNTS_OWNER_SUB).toMatch(
      /^tsub_[A-Za-z0-9_-]{32}$/u,
    );
    expect(config).toEqual(original);
  });

  test("refuses a missing, drifted, or undeclared DB-owned OIDC grant", async () => {
    const materializer = (config: InstallConfig) =>
      createTakosumiRuntimeBindingMaterializer({
        control: control(config),
        issuer: "https://app.takosumi.com",
        pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
        derivationKey: "runtime-secret-with-at-least-32-bytes",
      });
    const call = {
      request: {
        contract: "takosumi.runtime-bindings/v1",
        workspaceId: "ws_1",
        capsuleId: "cap_1",
        runId: "run_1",
        phase: "apply",
      },
      resourceName: "worker",
      scriptName: "yurucommu",
      publicOrigin: "https://yurucommu.example.test",
      bindings: [
        "ENCRYPTION_KEY",
        "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
      ],
    } as const;

    await expect(
      materializer(installConfig({ installExperience: undefined }))
        .materializeRuntimeBindings(call),
    ).rejects.toThrow(/grant/i);
    await expect(
      materializer(installConfig({
        installExperience: {
          projections: [{
            kind: "oidc_client",
            variables: {},
            callbackPath: "/different/callback",
            scopes: ["openid", "profile", "email"],
          }],
        },
      })).materializeRuntimeBindings(call),
    ).rejects.toThrow(/grant/i);
    await expect(
      materializer(installConfig({
        installExperience: {
          projections: [{
            kind: "oidc_client",
            variables: { clientId: "provider_owned_client_id" },
            callbackPath: "/api/auth/callback/takos",
            scopes: ["openid", "profile", "email"],
          }],
        },
      })).materializeRuntimeBindings(call),
    ).rejects.toThrow(/grant/i);
    await expect(
      materializer(installConfig()).materializeRuntimeBindings({
        ...call,
        bindings: ["ENCRYPTION_KEY"],
      }),
    ).rejects.toThrow(/binding/i);
  });
});

describe("Takos Accounts OIDC module-variable profile", () => {
  test("plans exactly four public values and honors an exact reviewed custom origin", async () => {
    const config = takosOidcInstallConfig({
      publicUrl: "https://takos.example.test",
    });
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        async getCapsule() {
          return takosOidcCapsule(config.id);
        },
        async getInstallConfig() {
          return config;
        },
      },
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => new Date("2026-08-25T12:01:00.000Z"),
    });

    const planned = await materializer.materialize({
      phase: "plan",
      capsule: takosOidcCapsule(config.id),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: takosOidcVariables("https://takos.example.test"),
    });

    expect(planned?.variables).toEqual({
      takosumi_accounts_url: "https://app.takosumi.com",
      takosumi_accounts_issuer_url: "https://app.takosumi.com",
      takosumi_accounts_client_id: expect.stringMatching(
        /^tko_[A-Za-z0-9_-]{43}$/u,
      ),
      takosumi_accounts_redirect_uri:
        "https://takos.example.test/auth/oidc/callback",
    });
    expect(writes).toBe(0);
  });

  test("uses workers.dev only when public_url is empty and rejects a non-origin override", async () => {
    let config = takosOidcInstallConfig();
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        async getCapsule() {
          return takosOidcCapsule(config.id);
        },
        async getInstallConfig() {
          return config;
        },
      },
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          throw new Error("Plan must not write");
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
    });
    const fallback = await materializer.materialize({
      phase: "plan",
      capsule: takosOidcCapsule(config.id),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: takosOidcVariables(),
    });
    expect(fallback?.variables.takosumi_accounts_redirect_uri).toBe(
      "https://takos-main.team-workers.workers.dev/auth/oidc/callback",
    );

    config = takosOidcInstallConfig({
      publicUrl: "https://takos.example.test/path",
    });
    await expect(materializer.materialize({
      phase: "plan",
      capsule: takosOidcCapsule(config.id),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: takosOidcVariables("https://takos.example.test/path"),
    })).rejects.toThrow(/HTTPS origin/i);
  });

  test("keeps the client stable across immutable config replacement and refreshes the live grant only on Apply", async () => {
    const accounts = new InMemoryAccountsStore();
    let config = takosOidcInstallConfig({
      id: "icfg_takos_old",
      updatedAt: "2026-08-25T12:00:00.000Z",
    });
    let capsule = takosOidcCapsule(config.id);
    let executionAuthorityEpoch = 1;
    let clock = new Date("2026-08-25T12:01:00.000Z");
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        async getCapsule() {
          return capsule;
        },
        async getInstallConfig() {
          return config;
        },
      },
      accounts,
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => clock,
    });
    const call = () => ({
      capsule,
      installConfig: config,
      capsuleExecutionAuthorityEpoch: executionAuthorityEpoch,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: takosOidcVariables(),
    });
    const firstPlan = await materializer.materialize({
      phase: "plan",
      ...call(),
    });
    await materializer.materialize({
      phase: "apply",
      expectedDigest: firstPlan!.digest,
      plannedVariables: firstPlan!.variables,
      ...call(),
    });
    const clientId = firstPlan!.variables.takosumi_accounts_client_id as string;
    expect(accounts.findOidcClient(clientId)?.updatedAt).toBe(clock.getTime());
    const oldActivationDigest = accounts.findOidcClient(clientId)!
      .activationDigest;
    // Models the old Apply winning after an orphan re-adoption target was
    // created but before its Capsule CAS could proceed.
    accounts.saveOidcClient({
      ...accounts.findOidcClient(clientId)!,
      updatedAt: Date.parse("2026-08-25T12:04:00.000Z"),
    });

    config = takosOidcInstallConfig({
      id: "icfg_takos_re_adopted",
      updatedAt: "2026-08-25T12:02:00.000Z",
    });
    capsule = takosOidcCapsule(config.id);
    executionAuthorityEpoch = 2;
    clock = new Date("2026-08-25T12:03:00.000Z");
    const operations = {
      capsules: {
        async getCapsule() {
          return capsule;
        },
        async getInstallConfig() {
          return config;
        },
        async getCapsuleExecutionAuthorityEpoch() {
          return executionAuthorityEpoch;
        },
      },
      workspaces: {
        async getWorkspace() {
          return { id: "ws_1", ownerUserId: "tsub_owner" };
        },
      },
      members: {
        async listMembers() {
          return [];
        },
      },
    } as unknown as ControlPlaneOperations;
    const grant = () => validateOidcLiveGrant({
      store: accounts,
      operations,
      client: { clientId, capsuleId: capsule.id, allowedScopes: TAKOS_SCOPES },
      scope: "openid capsules:read",
      takosumiSubject: "tsub_owner",
      capsuleId: capsule.id,
      workspaceId: capsule.workspaceId,
    });

    await expect(grant()).resolves.toEqual({
      ok: false,
      reason: "install_grant_stale",
    });
    const secondPlan = await materializer.materialize({
      phase: "plan",
      ...call(),
    });
    expect(secondPlan!.variables.takosumi_accounts_client_id).toBe(clientId);
    await materializer.materialize({
      phase: "apply_check",
      expectedDigest: secondPlan!.digest,
      plannedVariables: secondPlan!.variables,
      ...call(),
    });
    expect(accounts.findOidcClient(clientId)?.activationDigest).toBe(
      oldActivationDigest,
    );
    await expect(grant()).resolves.toMatchObject({
      ok: false,
      reason: "install_grant_stale",
    });
    await materializer.materialize({
      phase: "apply",
      expectedDigest: secondPlan!.digest,
      plannedVariables: secondPlan!.variables,
      ...call(),
    });
    expect(accounts.findOidcClient(clientId)?.updatedAt).toBe(
      Date.parse("2026-08-25T12:04:00.000Z"),
    );
    expect(accounts.findOidcClient(clientId)?.activationDigest).not.toBe(
      oldActivationDigest,
    );
    await expect(grant()).resolves.toMatchObject({
      ok: true,
      capsuleId: capsule.id,
      workspaceId: capsule.workspaceId,
      role: "owner",
    });
  });

  test("isolates deterministic public clients between Capsules", async () => {
    const configs = new Map([
      ["icfg_takos_a", takosOidcInstallConfig({ id: "icfg_takos_a" })],
      ["icfg_takos_b", takosOidcInstallConfig({ id: "icfg_takos_b" })],
    ]);
    const capsules = new Map([
      ["cap_takos_a", takosOidcCapsule("icfg_takos_a", "cap_takos_a")],
      ["cap_takos_b", takosOidcCapsule("icfg_takos_b", "cap_takos_b")],
    ]);
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        async getCapsule(id) {
          return capsules.get(id);
        },
        async getInstallConfig(id) {
          return configs.get(id);
        },
      },
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          throw new Error("Plan must not write");
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
    });
    const planned = await Promise.all([...capsules.values()].map((capsule) =>
      materializer.materialize({
        phase: "plan",
        capsule,
        installConfig: configs.get(capsule.installConfigId)!,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: takosOidcVariables(),
      })
    ));
    expect(planned[0]!.variables.takosumi_accounts_client_id).not.toBe(
      planned[1]!.variables.takosumi_accounts_client_id,
    );
  });

  test("validates the actual nested Cloudflare module target and accepts sealed legacy v2 metadata", async () => {
    let config = takosOidcInstallConfig();
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        async getCapsule() {
          return takosOidcCapsule(config.id);
        },
        async getInstallConfig() {
          return config;
        },
      },
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          throw new Error("Plan must not write");
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
    });

    const legacyProfile = config.accountsOidcModuleVariableMaterialization!;
    config = {
      ...config,
      accountsOidcModuleVariableMaterialization: {
        ...legacyProfile,
        additionalInputVariables: [
          "cloudflare_account_id",
          "cloudflare_workers_subdomain",
        ],
      },
    };
    await expect(materializer.materialize({
      phase: "plan",
      capsule: takosOidcCapsule(config.id),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      // Mirrors RunEngine after it filters provider defaults against the real
      // Takos root module, which declares `cloudflare` rather than flat names.
      variables: takosOidcVariables(),
    })).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });

    const base = takosOidcInstallConfig();
    for (const cloudflare of [
      {
        account_id: "0".repeat(32),
        workers_subdomain: "team-workers",
      },
      {
        account_id: CLOUDFLARE_ACCOUNT_ID,
        workers_subdomain: "other-team",
      },
      {
        account_id: CLOUDFLARE_ACCOUNT_ID,
        workers_subdomain: "team-workers",
        ignored_override: "not-closed",
      },
    ]) {
      config = {
        ...base,
        variableMapping: { ...base.variableMapping, cloudflare },
      };
      await expect(materializer.materialize({
        phase: "plan",
        capsule: takosOidcCapsule(config.id),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: takosOidcVariables(),
      })).rejects.toThrow(/verified metadata/i);
    }
  });
});

const CLOUDFLARE_PROVIDER =
  "registry.opentofu.org/cloudflare/cloudflare" as const;
const HTTP_PROVIDER = "registry.opentofu.org/hashicorp/http" as const;

function directOidcInstallConfig(): InstallConfig {
  const hosted = TAKOSERVER_HOSTED_INSTALL_CONFIGS.find(
    (config) => config.store?.deploymentProfile?.key === "cloudflare-v1",
  );
  if (!hosted) throw new Error("Cloudflare Host profile is missing");
  return {
    ...hosted,
    id: "icfg_yurucommu_direct",
    workspaceId: "ws_1",
    name: "Yurucommu direct Cloudflare",
    variableMapping: {
      ...hosted.variableMapping,
      project_name: "yuru-main",
      worker_name: "",
    },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function directOidcCapsule(status: "active" | "destroyed" = "active") {
  return {
    id: "cap_1",
    workspaceId: "ws_1",
    name: "Yurucommu",
    installConfigId: "icfg_yurucommu_direct",
    installingPrincipalId: "tsub_owner",
    status,
  } as const;
}

function directCloudflareBinding(
  overrides: Partial<ResolvedCapsuleProviderBinding["connection"]> = {},
): ResolvedCapsuleProviderBinding {
  const connection = {
    id: "conn_cloudflare_workspace",
    workspaceId: "ws_1",
    provider: CLOUDFLARE_PROVIDER,
    providerSource: CLOUDFLARE_PROVIDER,
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      secretPartition: "provider-credentials",
    },
    secretPartition: "provider-credentials",
    scope: "workspace" as const,
    status: "verified" as const,
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    scopeHints: {
      providerSettings: {
        accountId: CLOUDFLARE_ACCOUNT_ID,
        workersSubdomain: "team-workers",
      },
      moduleInputDefaults: {
        cloudflare_account_id: CLOUDFLARE_ACCOUNT_ID,
        cloudflare_workers_subdomain: "team-workers",
      },
    },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    verifiedAt: NOW.toISOString(),
    credentialVerification: {
      kind: "takosumi.credential-verification@v1" as const,
      verifierId: CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
      capabilities: [CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY],
    },
    ...overrides,
  };
  return {
    provider: CLOUDFLARE_PROVIDER,
    connection,
    materialization: connection.materialization,
  };
}

function unrelatedHttpBinding(): ResolvedCapsuleProviderBinding {
  return {
    provider: HTTP_PROVIDER,
    connection: {
      id: "conn_http_workspace",
      workspaceId: "ws_1",
      provider: HTTP_PROVIDER,
      providerSource: HTTP_PROVIDER,
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
      },
      secretPartition: "provider-credentials",
      scope: "workspace",
      status: "verified",
      materialization: "secret",
      envNames: ["HTTP_BEARER_TOKEN"],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      verifiedAt: NOW.toISOString(),
    },
    materialization: "secret",
  };
}

function directOidcVariables() {
  return {
    project_name: "yuru-main",
    worker_name: "",
    cloudflare_account_id: CLOUDFLARE_ACCOUNT_ID,
    cloudflare_workers_subdomain: "team-workers",
  } as const;
}

function directOidcControl(
  current: () => InstallConfig | undefined,
  currentCapsule: () => ReturnType<typeof directOidcCapsule> = () =>
    directOidcCapsule(),
): AccountsOidcModuleVariableControlLedger {
  return {
    async getCapsule() {
      return currentCapsule();
    },
    async getInstallConfig() {
      return current();
    },
  };
}

const TAKOS_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "capsules:read",
  "capsules:write",
] as const;

function takosOidcInstallConfig(input: {
  readonly id?: string;
  readonly updatedAt?: string;
  readonly publicUrl?: string | null;
} = {}): InstallConfig {
  const hosted = composeTakosInstallConfig({
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL:
      "https://github.com/tako0614/takos/releases/download/v0.12.6/takosumi-artifact.json",
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256:
      `sha256:${"a".repeat(64)}`,
  });
  if (!hosted) throw new Error("Takos hosted profile is missing");
  return {
    ...hosted,
    id: input.id ?? "icfg_takos_1",
    workspaceId: "ws_1",
    name: "Takos direct Cloudflare",
    variableMapping: {
      project_name: "takos-main",
      public_url: input.publicUrl ?? null,
      cloudflare: {
        account_id: CLOUDFLARE_ACCOUNT_ID,
        workers_subdomain: "team-workers",
      },
    },
    createdAt: NOW.toISOString(),
    updatedAt: input.updatedAt ?? NOW.toISOString(),
  };
}

function takosOidcCapsule(
  installConfigId = "icfg_takos_1",
  capsuleId = "cap_takos_1",
) {
  return {
    id: capsuleId,
    workspaceId: "ws_1",
    name: `Takos ${capsuleId}`,
    installConfigId,
    installingPrincipalId: "tsub_owner",
    status: "active" as const,
  };
}

function takosOidcVariables(publicUrl: string | null = null) {
  return {
    project_name: "takos-main",
    public_url: publicUrl,
  } as const;
}

describe("Takosumi Accounts OIDC module-variable materializer", () => {
  test("keeps Plan pure, then registers one Capsule client during guarded Apply", async () => {
    const config = directOidcInstallConfig();
    const saved: OidcClientRecord[] = [];
    let current: OidcClientRecord | undefined;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient(clientId) {
          return current?.clientId === clientId ? current : undefined;
        },
        async findOidcClientForCapsule(capsuleId) {
          return current?.capsuleId === capsuleId ? current : undefined;
        },
        async saveOidcClient(record) {
          current = record;
          saved.push(record);
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    const first = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    expect(first?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first?.variables).toEqual({
      takosumi_accounts_issuer_url: "https://app.takosumi.com",
      takosumi_accounts_client_id: expect.stringMatching(
        /^tko_[A-Za-z0-9_-]{43}$/u,
      ),
      oidc_owner_sub: expect.stringMatching(/^tsub_[A-Za-z0-9_-]{32}$/u),
      allow_unpinned_owner_claim: false,
    });
    expect(JSON.stringify(first)).not.toContain("ENCRYPTION_KEY");
    expect(JSON.stringify(first)).not.toContain("pairwise-secret");
    expect(saved).toHaveLength(0);

    const checked = await materializer.materialize({
      phase: "apply_check",
      expectedDigest: first!.digest,
      plannedVariables: first!.variables,
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    expect(checked).toEqual(first);
    expect(saved).toHaveLength(0);

    const second = await materializer.materialize({
      phase: "apply",
      expectedDigest: first!.digest,
      plannedVariables: first!.variables,
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    expect(second).toEqual(first);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      capsuleId: "cap_1",
      issuerUrl: "https://app.takosumi.com",
      redirectUris: [
        "https://yuru-main.team-workers.workers.dev/api/auth/callback/takos",
      ],
      allowedScopes: ["openid", "profile", "email"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "none",
    });

    const repeated = await materializer.materialize({
      phase: "apply",
      expectedDigest: first!.digest,
      plannedVariables: first!.variables,
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    expect(repeated).toEqual(first);
    expect(saved).toHaveLength(1);
  });

  test("retires only the exact DB-owned client after the current Capsule is terminal", async () => {
    const config = directOidcInstallConfig();
    let capsuleStatus: "active" | "destroyed" = "active";
    let current: OidcClientRecord | undefined;
    let saves = 0;
    const revoked: string[] = [];
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(
        () => config,
        () => directOidcCapsule(capsuleStatus),
      ),
      accounts: {
        async findOidcClient(clientId) {
          return current?.clientId === clientId ? current : undefined;
        },
        async findOidcClientForCapsule(capsuleId) {
          return current?.capsuleId === capsuleId ? current : undefined;
        },
        async saveOidcClient(record) {
          current = record;
          saves += 1;
        },
        async revokeOidcClient(clientId) {
          revoked.push(clientId);
          if (current?.clientId === clientId) current = undefined;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    await materializer.materialize({
      phase: "apply",
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    const clientId = current!.clientId;
    expect(saves).toBe(1);

    capsuleStatus = "destroyed";
    expect(materializer.retire).toBeFunction();
    await materializer.retire({
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      capsule: directOidcCapsule("destroyed"),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });

    expect(saves).toBe(1);
    expect(revoked).toEqual([clientId]);
    expect(current).toBeUndefined();
  });

  test("treats an absent terminal Capsule client as an idempotent retirement", async () => {
    const config = directOidcInstallConfig();
    let capsuleStatus: "active" | "destroyed" = "active";
    let saves = 0;
    const revoked: string[] = [];
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(
        () => config,
        () => directOidcCapsule(capsuleStatus),
      ),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          saves += 1;
        },
        async revokeOidcClient(clientId) {
          revoked.push(clientId);
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    capsuleStatus = "destroyed";
    const retirement = {
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      capsule: directOidcCapsule("destroyed"),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    } as const;

    await materializer.retire(retirement);
    await materializer.retire(retirement);

    expect(saves).toBe(0);
    expect(revoked).toEqual([
      planned!.variables.takosumi_accounts_client_id,
      planned!.variables.takosumi_accounts_client_id,
    ]);
  });

  test("rejects OIDC client retirement before the current Capsule is terminal", async () => {
    const config = directOidcInstallConfig();
    let saves = 0;
    let revocations = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          saves += 1;
        },
        async revokeOidcClient() {
          revocations += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });

    await expect(
      materializer.retire({
        expectedDigest: planned!.digest,
        plannedVariables: planned!.variables,
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow(/terminal Capsule/i);
    expect(saves).toBe(0);
    expect(revocations).toBe(0);
  });

  test("rejects planned OIDC variable drift before Accounts mutation", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });

    await expect(
      materializer.materialize({
        phase: "apply",
        expectedDigest: planned!.digest,
        plannedVariables: {
          ...planned!.variables,
          takosumi_accounts_client_id: "tko_reviewed_different_client",
        },
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow(/planned.*variable/i);
    expect(writes).toBe(0);
  });

  test("rejects current Accounts client metadata drift before rewriting it", async () => {
    const config = directOidcInstallConfig();
    const deriving = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          throw new Error("Plan must not write");
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await deriving.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    const current: OidcClientRecord = {
      clientId: planned!.variables.takosumi_accounts_client_id as string,
      capsuleId: "cap_1",
      namespacePath: "identity.oidc",
      issuerUrl: "https://stale-issuer.example.test",
      redirectUris: [
        "https://yuru-main.team-workers.workers.dev/api/auth/callback/takos",
      ],
      allowedScopes: ["openid", "profile", "email"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "none",
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    };
    let writes = 0;
    const checking = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return current;
        },
        async findOidcClientForCapsule() {
          return current;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      checking.materialize({
        phase: "apply_check",
        expectedDigest: planned!.digest,
        plannedVariables: planned!.variables,
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow(/current Accounts OIDC client.*drift/i);
    expect(writes).toBe(0);
  });

  test("rejects an existing Capsule client collision before Accounts mutation", async () => {
    const config = directOidcInstallConfig();
    const emptyAccounts = {
      async findOidcClient() {
        return undefined;
      },
      async findOidcClientForCapsule() {
        return undefined;
      },
      async saveOidcClient() {
        throw new Error("Plan must not write");
      },
    };
    const deriving = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: emptyAccounts,
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await deriving.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    const collision: OidcClientRecord = {
      clientId: "tko_another_capsule_client",
      capsuleId: "cap_1",
      namespacePath: "identity.oidc",
      issuerUrl: "https://app.takosumi.com",
      redirectUris: [
        "https://yuru-main.team-workers.workers.dev/api/auth/callback/takos",
      ],
      allowedScopes: ["openid", "profile", "email"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "none",
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    };
    let writes = 0;
    const checking = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return collision;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      checking.materialize({
        phase: "apply_check",
        expectedDigest: planned!.digest,
        plannedVariables: planned!.variables,
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow(/already bound to another OIDC client/i);
    expect(writes).toBe(0);
  });

  test("accepts capability-authorized OAuth and workspace-bindable operator Cloudflare bindings", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    for (const binding of [
      directCloudflareBinding({
        credentialRecipe: {
          id: "cloudflare",
          authMode: "oauth",
          secretPartition: "provider-credentials",
        },
      }),
      directCloudflareBinding({
        id: "conn_cloudflare_operator",
        scope: "operator",
        workspaceId: undefined,
        secretPartition: undefined,
        materialization: "run-issued",
        credentialRecipe: {
          id: "operator-cloudflare",
          authMode: "broker",
          runIssuance: {
            context: "capsule-run.v1",
            operatorConnection: "workspace-bindable",
            storedMaterial: "none",
            audience: "cloudflare.operator.v1",
            scopes: ["cloudflare:workers"],
          },
        },
      }),
    ]) {
      const materialized = await materializer.materialize(
        {
          phase: "plan",
          capsule: directOidcCapsule(),
          installConfig: config,
          resolvedProviderBindings: [binding],
          variables: directOidcVariables(),
        },
      );
      expect(materialized?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
    expect(writes).toBe(0);
  });

  test("accepts the production Cloudflare binding when the resolved source is canonical and the recipe label is opaque", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [
          directCloudflareBinding({ provider: "cloudflare/cloudflare" }),
        ],
        variables: directOidcVariables(),
      }),
    ).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(writes).toBe(0);
  });

  test("accepts unrelated authorized bindings and a widened provider policy", async () => {
    const base = directOidcInstallConfig();
    const credentialPolicy = base.policy.providerCredentials!;
    const config: InstallConfig = {
      ...base,
      policy: {
        ...base.policy,
        allowedProviders: [
          ...(base.policy.allowedProviders ?? []),
          "registry.opentofu.org/hashicorp/null",
        ],
        providerCredentials: {
          ...credentialPolicy,
          allowedConnectionScopes: ["workspace", "operator"],
          allowedCredentialRecipes: [
            ...(credentialPolicy.allowedCredentialRecipes ?? []),
            { id: "cloudflare", authMode: "oauth" },
          ],
        },
      },
    };
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [
          directCloudflareBinding(),
          unrelatedHttpBinding(),
        ],
        variables: directOidcVariables(),
      }),
    ).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(writes).toBe(0);
  });

  test("requires one current Cloudflare binding with valid scope authority", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    for (const bindings of [
      [] as ResolvedCapsuleProviderBinding[],
      [
        directCloudflareBinding(),
        directCloudflareBinding({ id: "conn_cloudflare_duplicate" }),
      ],
      [directCloudflareBinding({ status: "pending", verifiedAt: undefined })],
      [
        directCloudflareBinding({
          providerSource: "registry.opentofu.org/hashicorp/null",
        }),
      ],
      [directCloudflareBinding({ workspaceId: "ws_other" })],
      [
        directCloudflareBinding({
          scope: "operator",
          workspaceId: undefined,
          credentialRecipe: {
            id: "cloudflare",
            authMode: "oauth",
            secretPartition: "provider-credentials",
          },
        }),
      ],
    ]) {
      await expect(
        materializer.materialize({
          phase: "plan",
          capsule: directOidcCapsule(),
          installConfig: config,
          resolvedProviderBindings: bindings,
          variables: directOidcVariables(),
        }),
      ).rejects.toThrow();
    }
    expect(writes).toBe(0);
  });

  test("uses the verification capability instead of verifier or recipe identity", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    const rejectedOverrides: Partial<
      ResolvedCapsuleProviderBinding["connection"]
    >[] = [
      {
        credentialVerification: undefined,
      },
      {
        credentialRecipe: {
          id: "generic-env",
          authMode: "env",
          secretPartition: "provider-credentials",
        },
        credentialVerification: {
          kind: "takosumi.credential-verification@v1" as const,
          verifierId: "declared-env@v1",
        },
      },
      {
        credentialVerification: {
          kind: "takosumi.credential-verification@v1",
          verifierId: "cloudflare/legacy-account-only@v1",
        },
      },
    ];
    for (const connectionOverrides of rejectedOverrides) {
      await expect(
        materializer.materialize({
          phase: "plan",
          capsule: directOidcCapsule(),
          installConfig: config,
          resolvedProviderBindings: [
            directCloudflareBinding(connectionOverrides),
          ],
          variables: directOidcVariables(),
        }),
      ).rejects.toThrow(/verification capability/i);
    }

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [
          directCloudflareBinding({
            credentialRecipe: {
              id: "cloudflare",
              authMode: "oauth",
              secretPartition: "provider-credentials",
            },
            credentialVerification: {
              kind: "takosumi.credential-verification@v1",
              verifierId: "example/replacement-cloudflare-verifier@v2",
              capabilities: [
                CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
              ],
            },
          }),
        ],
        variables: directOidcVariables(),
      }),
    ).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(writes).toBe(0);
  });

  test("requires the exact OIDC callback and scope declaration before Accounts mutation", async () => {
    const base = directOidcInstallConfig();
    let writes = 0;
    const accounts = {
      async findOidcClient() {
        return undefined;
      },
      async findOidcClientForCapsule() {
        return undefined;
      },
      async saveOidcClient() {
        writes += 1;
      },
    };

    for (const projection of [
      {
        kind: "oidc_client" as const,
        variables: {},
        callbackPath: "/api/auth/callback/other",
        scopes: ["openid", "profile", "email"],
      },
      {
        kind: "oidc_client" as const,
        variables: {},
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile", "email", "email"],
      },
    ]) {
      const config: InstallConfig = {
        ...base,
        installExperience: { projections: [projection] },
      };
      const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
        control: directOidcControl(() => config),
        accounts,
        issuer: "https://app.takosumi.com",
        pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
        clock: () => NOW,
      });

      await expect(
        materializer.materialize({
          phase: "plan",
          capsule: directOidcCapsule(),
          installConfig: config,
          resolvedProviderBindings: [directCloudflareBinding()],
          variables: directOidcVariables(),
        }),
      ).rejects.toThrow(/grant is not exact/i);
    }
    expect(writes).toBe(0);
  });

  test("requires the Capsule installing Principal before Accounts mutation", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        async getCapsule() {
          return { ...directOidcCapsule(), installingPrincipalId: undefined };
        },
        async getInstallConfig() {
          return config;
        },
      },
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: { ...directOidcCapsule(), installingPrincipalId: undefined },
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow(/installing Principal/i);
    expect(writes).toBe(0);
  });

  test("rejects missing verified account or workers-subdomain metadata", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [
          directCloudflareBinding({
            scopeHints: {
              providerSettings: { accountId: CLOUDFLARE_ACCOUNT_ID },
              moduleInputDefaults: {
                cloudflare_account_id: CLOUDFLARE_ACCOUNT_ID,
              },
            },
          }),
        ],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });

  test("rejects a legacy malformed Cloudflare account id despite matching attested defaults", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const malformedAccountId = "acct_verified";

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [
          directCloudflareBinding({
            scopeHints: {
              providerSettings: {
                accountId: malformedAccountId,
                workersSubdomain: "team-workers",
              },
              moduleInputDefaults: {
                cloudflare_account_id: malformedAccountId,
                cloudflare_workers_subdomain: "team-workers",
              },
            },
          }),
        ],
        variables: {
          ...directOidcVariables(),
          cloudflare_account_id: malformedAccountId,
        },
      }),
    ).rejects.toThrow(/verified metadata is incomplete/i);
    expect(writes).toBe(0);
  });

  test("rejects module account or workers-subdomain overrides that differ from verified metadata", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    for (const variables of [
      { ...directOidcVariables(), cloudflare_account_id: "acct_override" },
      {
        ...directOidcVariables(),
        cloudflare_workers_subdomain: "other-team",
      },
    ]) {
      await expect(
        materializer.materialize({
          phase: "plan",
          capsule: directOidcCapsule(),
          installConfig: config,
          resolvedProviderBindings: [directCloudflareBinding()],
          variables,
        }),
      ).rejects.toThrow(/verified metadata/i);
    }
    expect(writes).toBe(0);
  });

  test("rejects a secret-shaped module target before Accounts mutation", async () => {
    const base = directOidcInstallConfig();
    const config: InstallConfig = {
      ...base,
      accountsOidcModuleVariableMaterialization: {
        ...base.accountsOidcModuleVariableMaterialization!,
        ownerSubjectVariable: "encryption_key",
      },
    };
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow(/target/i);
    expect(writes).toBe(0);
  });

  test("rejects raw user secret inputs at the private materializer boundary", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materialize({
        phase: "plan",
        capsule: directOidcCapsule(),
        installConfig: config,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: {
          ...directOidcVariables(),
          auth_password_hash: "$argon2id$must-not-cross",
        },
      }),
    ).rejects.toThrow(/exact non-secret metadata/i);
    expect(writes).toBe(0);
  });

  test("requires the exact Cloudflare/Yuru declaration metadata names", async () => {
    const base = directOidcInstallConfig();
    let current = base;
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => current),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    for (const declaration of [
      { additionalInputVariables: ["tenant_slug"] },
      {
        forbiddenNonEmptyInputVariables: [
          "auth_password_hash",
          "another_secret_token",
        ],
      },
    ]) {
      current = {
        ...base,
        accountsOidcModuleVariableMaterialization: {
          ...base.accountsOidcModuleVariableMaterialization!,
          ...declaration,
        },
      };
      await expect(
        materializer.materialize({
          phase: "plan",
          capsule: directOidcCapsule(),
          installConfig: current,
          resolvedProviderBindings: [directCloudflareBinding()],
          variables: directOidcVariables(),
        }),
      ).rejects.toThrow(/metadata inputs are not exact/i);
    }
    expect(writes).toBe(0);
  });

  test("rejects InstallConfig materialization drift before rewriting the OIDC client", async () => {
    let current = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => current),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: current,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    expect(writes).toBe(0);

    current = {
      ...current,
      accountsOidcModuleVariableMaterialization: {
        ...current.accountsOidcModuleVariableMaterialization!,
        clientIdVariable: "changed_client_id",
      },
      updatedAt: "2026-08-25T12:00:01.000Z",
    };
    await expect(
      materializer.materialize({
        phase: "apply",
        expectedDigest: planned!.digest,
        capsule: directOidcCapsule(),
        installConfig: current,
        resolvedProviderBindings: [directCloudflareBinding()],
        variables: directOidcVariables(),
      }),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });

  test("rejects verified Cloudflare metadata drift against the Plan digest", async () => {
    const config = directOidcInstallConfig();
    let writes = 0;
    const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
      control: directOidcControl(() => config),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });
    const planned = await materializer.materialize({
      phase: "plan",
      capsule: directOidcCapsule(),
      installConfig: config,
      resolvedProviderBindings: [directCloudflareBinding()],
      variables: directOidcVariables(),
    });
    expect(writes).toBe(0);
    const changedBinding = directCloudflareBinding({
      scopeHints: {
        providerSettings: {
          accountId: CLOUDFLARE_ACCOUNT_ID,
          workersSubdomain: "new-team",
        },
        moduleInputDefaults: {
          cloudflare_account_id: CLOUDFLARE_ACCOUNT_ID,
          cloudflare_workers_subdomain: "new-team",
        },
      },
      verifiedAt: "2026-08-25T12:00:01.000Z",
    });

    for (const phase of ["plan", "apply"] as const) {
      await expect(
        materializer.materialize({
          phase,
          expectedDigest: planned!.digest,
          capsule: directOidcCapsule(),
          installConfig: config,
          resolvedProviderBindings: [changedBinding],
          variables: {
            ...directOidcVariables(),
            cloudflare_workers_subdomain: "new-team",
          },
        }),
      ).rejects.toThrow(/changed since Plan/i);
    }
    expect(writes).toBe(0);
  });
});
