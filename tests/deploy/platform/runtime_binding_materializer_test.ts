import { describe, expect, test } from "bun:test";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { OidcClientRecord } from "../../../accounts/service/src/store.ts";
import {
  createTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingControlLedger,
} from "../../../deploy/platform/runtime_binding_materializer.ts";
import {
  createTakosumiAccountsOidcModuleVariableMaterializer,
  type AccountsOidcModuleVariableControlLedger,
} from "../../../deploy/platform/accounts_oidc_module_variable_materializer.ts";
import { TAKOSERVER_HOSTED_INSTALL_CONFIGS } from "../../../deploy/platform/takoserver_hosted_install_configs.ts";
import type { ResolvedCapsuleProviderBinding } from "../../../core/domains/connections/mod.ts";
import {
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
} from "../../../providers/cloudflare/credentials.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

function installConfig(): InstallConfig {
  return {
    id: "icfg_yurucommu",
    workspaceId: "ws_1",
    name: "Yurucommu",
    variableMapping: {},
    installExperience: { projections: [{ kind: "service_name", variable: "project_name" }] },
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
  } as InstallConfig;
}

function control(
  context = {
    workspaceId: "ws_1",
    capsuleId: "cap_1",
    runId: "run_1",
    installingPrincipalId: "tsub_owner",
    phase: "apply" as const,
    lifecycleIntent: "provision" as const,
  },
): RuntimeBindingControlLedger {
  return {
    async resolveContext() {
      return { ok: true, context };
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
      return installConfig();
    },
    async putInstallConfig(config) {
      return config;
    },
  };
}

describe("Takosumi runtime binding materializer", () => {
  test("materializes only the DB-owned exact binding set and registers a live OIDC client", async () => {
    const saved: unknown[] = [];
    const materializer = createTakosumiRuntimeBindingMaterializer({
      control: control(),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient(record) {
          saved.push(record);
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      derivationKey: "runtime-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    const request = {
      contract: "takosumi.runtime-bindings/v1",
      workspaceId: "ws_1",
      capsuleId: "cap_1",
      runId: "run_1",
      phase: "apply",
    } as const;
    const bindings = [
      "ENCRYPTION_KEY",
      "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
    ] as const;
    const first = await materializer.materializeRuntimeBindings({
      request,
      resourceName: "takoform_worker_version.yurucommu",
      scriptName: "yurucommu",
      publicOrigin: "https://yurucommu.example.test",
      bindings,
    });
    const second = await materializer.materializeRuntimeBindings({
      request,
      resourceName: "takoform_worker_version.yurucommu",
      scriptName: "yurucommu",
      publicOrigin: "https://yurucommu.example.test",
      bindings,
    });

    expect(Object.keys(first.values).sort()).toEqual([...bindings].sort());
    expect(first.values.ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.values).toEqual(first.values);
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
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)).toMatchObject({
      clientId: first.values.TAKOSUMI_ACCOUNTS_CLIENT_ID,
      capsuleId: "cap_1",
      namespacePath: "identity.oidc",
      issuerUrl: "https://app.takosumi.com",
      redirectUris: [
        "https://yurucommu.example.test/api/auth/callback/takos",
      ],
      allowedScopes: ["openid", "profile", "email"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "none",
    });
  });

  test("refuses drift or undeclared bindings before Accounts mutation", async () => {
    let writes = 0;
    const materializer = createTakosumiRuntimeBindingMaterializer({
      control: control(),
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
      derivationKey: "runtime-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materializeRuntimeBindings({
        request: {
          contract: "takosumi.runtime-bindings/v1",
          workspaceId: "ws_other",
          capsuleId: "cap_1",
          runId: "run_1",
          phase: "apply",
        },
        resourceName: "worker",
        scriptName: "yurucommu",
        publicOrigin: "https://yurucommu.example.test",
        bindings: ["ENCRYPTION_KEY"],
      }),
    ).rejects.toThrow();
    expect(writes).toBe(0);
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
