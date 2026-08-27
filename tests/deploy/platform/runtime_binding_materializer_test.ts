import { describe, expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { OidcClientRecord } from "../../../accounts/service/src/store.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import {
  createTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingControlLedger,
} from "../../../deploy/platform/runtime_binding_materializer.ts";
import {
  createTakosumiAccountsOidcModuleVariableMaterializer,
  type AccountsOidcModuleVariableAccountsLedger,
  type AccountsOidcModuleVariableControlLedger,
} from "../../../deploy/platform/accounts_oidc_module_variable_materializer.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const PAIRWISE_SECRET = "pairwise-secret-with-at-least-32-bytes";

function runtimeBindingInstallConfig(
  overrides: Partial<InstallConfig> = {},
): InstallConfig {
  return {
    id: "icfg_legacy_runtime_binding",
    workspaceId: "ws_1",
    name: "Legacy private runtime binding fixture",
    variableMapping: {},
    installExperience: {
      projections: [{
        kind: "oidc_client",
        variables: {},
        callbackPath: "/auth/legacy/callback",
        scopes: ["openid", "profile", "email"],
      }],
    },
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [{
        binding: "ENCRYPTION_KEY",
        bytes: 32,
        encoding: "hex",
      }],
      oidcClient: {
        issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
        callbackPath: "/auth/legacy/callback",
        scopes: ["openid", "profile", "email"],
      },
    },
    outputAllowlist: {},
    policy: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function runtimeBindingControl(
  config: InstallConfig = runtimeBindingInstallConfig(),
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
        name: "Legacy private app",
        installConfigId: config.id,
      };
    },
    async getInstallConfig() {
      return config;
    },
  };
}

describe("Takosumi runtime binding materializer", () => {
  test("derives the exact DB-owned values read-only in every provider phase", async () => {
    const config = runtimeBindingInstallConfig();
    const original = structuredClone(config);
    const materializer = createTakosumiRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: PAIRWISE_SECRET,
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
          resourceName: "external_worker_version.app",
          scriptName: "legacy-app",
          publicOrigin: "https://legacy-app.example.test",
          bindings,
        })
      ),
    );

    expect(Object.keys(outcomes[0]!.values).sort()).toEqual(
      [...bindings].sort(),
    );
    expect(outcomes[0]!.values.ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcomes.slice(1).every((outcome) =>
      JSON.stringify(outcome.values) === JSON.stringify(outcomes[0]!.values)
    )).toBe(true);
    expect(outcomes[0]!.values.TAKOSUMI_ACCOUNTS_REDIRECT_URI).toBe(
      "https://legacy-app.example.test/auth/legacy/callback",
    );
    expect(config).toEqual(original);
  });

  test("refuses a missing or drifted DB-owned runtime grant", async () => {
    const materializer = (config: InstallConfig) =>
      createTakosumiRuntimeBindingMaterializer({
        control: runtimeBindingControl(config),
        issuer: "https://app.takosumi.com",
        pairwiseSubjectSecret: PAIRWISE_SECRET,
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
      scriptName: "legacy-app",
      publicOrigin: "https://legacy-app.example.test",
      bindings: [
        "ENCRYPTION_KEY",
        "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
      ],
    } as const;

    await expect(
      materializer(runtimeBindingInstallConfig({ installExperience: undefined }))
        .materializeRuntimeBindings(call),
    ).rejects.toThrow(/grant/i);
    await expect(
      materializer(runtimeBindingInstallConfig({
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
  });
});

function repositoryOidcInstallConfig(input: {
  readonly publicUrl?: string | null;
  readonly allowedScopes?: readonly string[];
  readonly grantScopes?: readonly string[];
} = {}): InstallConfig {
  const publicUrl = input.publicUrl === undefined
    ? "https://staging.example.test"
    : input.publicUrl;
  const grantScopes = input.grantScopes ?? ["openid", "profile"];
  return {
    id: "icfg_repository_oidc",
    workspaceId: "ws_1",
    name: "Generic reviewed Git app",
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_generic_oidc",
      repositoryInstallUxDigest: `sha256:${"b".repeat(64)}`,
    },
    variableMapping: { public_url: publicUrl },
    installExperience: {
      projections: [
        { kind: "public_endpoint", variables: { url: "public_url" } },
        {
          kind: "oidc_client",
          variables: {
            accountsUrl: "takosumi_accounts_url",
            issuerUrl: "takosumi_accounts_issuer_url",
            clientId: "takosumi_accounts_client_id",
            redirectUri: "takosumi_accounts_redirect_uri",
          },
          callbackPath: "/auth/oidc/callback",
          scopes: grantScopes,
        },
      ],
      repositoryInstallUx: { status: "accepted" },
    },
    outputAllowlist: {},
    policy: {
      repositoryInstallUx: {
        allowedInterfacePermissions: [],
        allowedOidcScopes: input.allowedScopes ?? ["openid", "profile"],
      },
    },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function oidcCapsule(
  status: Capsule["status"] = "active",
  installingPrincipalId: string | undefined = "tsub_owner",
): Capsule {
  return {
    id: "cap_1",
    workspaceId: "ws_1",
    projectId: "project_1",
    name: "Generic reviewed Git app",
    slug: "generic-reviewed-git-app",
    sourceId: "source_1",
    installConfigId: "icfg_repository_oidc",
    ...(installingPrincipalId ? { installingPrincipalId } : {}),
    environment: "staging",
    currentStateGeneration: 0,
    status,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function oidcControl(
  currentConfig: () => InstallConfig | undefined,
  currentCapsule: () => Capsule = () => oidcCapsule(),
): AccountsOidcModuleVariableControlLedger {
  return {
    async getCapsule() {
      return currentCapsule();
    },
    async getInstallConfig() {
      return currentConfig();
    },
  };
}

function createOidcMaterializer(input: {
  readonly config: () => InstallConfig | undefined;
  readonly capsule?: () => Capsule;
  readonly accounts: AccountsOidcModuleVariableAccountsLedger;
}) {
  return createTakosumiAccountsOidcModuleVariableMaterializer({
    control: oidcControl(input.config, input.capsule),
    accounts: input.accounts,
    issuer: "https://app.takosumi.com",
    pairwiseSubjectSecret: PAIRWISE_SECRET,
    clock: () => NOW,
  });
}

function call(config: InstallConfig, capsule: Capsule = oidcCapsule()) {
  return {
    capsule,
    installConfig: config,
    resolvedProviderBindings: [],
    variables: { public_url: config.variableMapping.public_url },
  } as const;
}

describe("Takosumi repository Accounts OIDC materializer", () => {
  test("keeps Plan read-only and registers one Capsule client only on Apply", async () => {
    const config = repositoryOidcInstallConfig();
    let current: OidcClientRecord | undefined;
    let writes = 0;
    const materializer = createOidcMaterializer({
      config: () => config,
      accounts: {
        async findOidcClient(clientId) {
          return current?.clientId === clientId ? current : undefined;
        },
        async findOidcClientForCapsule(capsuleId) {
          return current?.capsuleId === capsuleId ? current : undefined;
        },
        async saveOidcClient(record) {
          current = record;
          writes += 1;
        },
      },
    });

    const planned = await materializer.materialize({
      phase: "plan",
      ...call(config),
    });
    expect(writes).toBe(0);
    expect(planned).toEqual({
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      variables: {
        takosumi_accounts_url: "https://app.takosumi.com",
        takosumi_accounts_issuer_url: "https://app.takosumi.com",
        takosumi_accounts_client_id: expect.stringMatching(
          /^tko_[A-Za-z0-9_-]{43}$/u,
        ),
        takosumi_accounts_redirect_uri:
          "https://staging.example.test/auth/oidc/callback",
      },
    });

    const applied = await materializer.materialize({
      phase: "apply",
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      ...call(config),
    });
    expect(applied).toEqual(planned);
    expect(writes).toBe(1);
    expect(current).toMatchObject({
      capsuleId: "cap_1",
      redirectUris: ["https://staging.example.test/auth/oidc/callback"],
      allowedScopes: ["openid", "profile"],
    });
  });

  test("requires an exact Plan-known HTTPS public origin", async () => {
    for (const publicUrl of [
      null,
      "",
      "http://staging.example.test",
      "https://staging.example.test/path",
    ]) {
      const config = repositoryOidcInstallConfig({ publicUrl });
      let writes = 0;
      const materializer = createOidcMaterializer({
        config: () => config,
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
      });

      await expect(materializer.materialize({
        phase: "plan",
        ...call(config),
      })).rejects.toThrow(/public URL|HTTPS origin/i);
      expect(writes).toBe(0);
    }
  });

  test("does not materialize a manual or operator-only OIDC projection", async () => {
    const repository = repositoryOidcInstallConfig();
    const config: InstallConfig = {
      ...repository,
      internal: undefined,
      installExperience: {
        ...repository.installExperience,
        repositoryInstallUx: undefined,
      },
    };
    const materializer = createOidcMaterializer({
      config: () => config,
      accounts: {
        async findOidcClient() {
          throw new Error("manual projection must not read Accounts");
        },
        async findOidcClientForCapsule() {
          throw new Error("manual projection must not read Accounts");
        },
        async saveOidcClient() {
          throw new Error("manual projection must not write Accounts");
        },
      },
    });

    await expect(materializer.materialize({
      phase: "plan",
      ...call(config),
    })).resolves.toBeUndefined();
  });

  test("rejects scope policy and exact delivery drift before Accounts mutation", async () => {
    const base = repositoryOidcInstallConfig();
    const oidc = base.installExperience!.projections!.find(
      (projection) => projection.kind === "oidc_client",
    )!;
    const drifted = [
      repositoryOidcInstallConfig({ allowedScopes: ["openid"] }),
      {
        ...base,
        installExperience: {
          ...base.installExperience,
          projections: base.installExperience!.projections!.map((projection) =>
            projection.kind === "oidc_client"
              ? {
                  ...oidc,
                  variables: {
                    ...oidc.variables,
                    clientId: oidc.variables.issuerUrl,
                  },
                }
              : projection
          ),
        },
      } satisfies InstallConfig,
    ];

    for (const config of drifted) {
      let writes = 0;
      const materializer = createOidcMaterializer({
        config: () => config,
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
      });
      await expect(materializer.materialize({
        phase: "plan",
        ...call(config),
      })).rejects.toThrow(/scope|variable/i);
      expect(writes).toBe(0);
    }
  });

  test("rejects callback drift between Plan and Apply", async () => {
    let config = repositoryOidcInstallConfig();
    let writes = 0;
    const materializer = createOidcMaterializer({
      config: () => config,
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
    });
    const planned = await materializer.materialize({
      phase: "plan",
      ...call(config),
    });
    config = {
      ...config,
      installExperience: {
        ...config.installExperience,
        projections: config.installExperience!.projections!.map((projection) =>
          projection.kind === "oidc_client"
            ? { ...projection, callbackPath: "/changed/callback" }
            : projection
        ),
      },
      updatedAt: "2026-08-25T12:00:01.000Z",
    };

    await expect(materializer.materialize({
      phase: "apply",
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      ...call(config),
    })).rejects.toThrow(/changed since Plan/i);
    expect(writes).toBe(0);
  });

  test("fails closed when the Accounts read capability is unavailable", async () => {
    const config = repositoryOidcInstallConfig();
    let writes = 0;
    const materializer = createOidcMaterializer({
      config: () => config,
      accounts: {
        async findOidcClient() {
          throw new Error("Accounts unavailable");
        },
        async findOidcClientForCapsule() {
          throw new Error("Accounts unavailable");
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
    });

    await expect(materializer.materialize({
      phase: "plan",
      ...call(config),
    })).rejects.toThrow(/Accounts unavailable/i);
    expect(writes).toBe(0);
  });

  test("rejects planned-variable drift before Apply mutation", async () => {
    const config = repositoryOidcInstallConfig();
    let writes = 0;
    const materializer = createOidcMaterializer({
      config: () => config,
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
    });
    const planned = await materializer.materialize({
      phase: "plan",
      ...call(config),
    });

    await expect(materializer.materialize({
      phase: "apply",
      expectedDigest: planned!.digest,
      plannedVariables: {
        ...planned!.variables,
        takosumi_accounts_redirect_uri:
          "https://attacker.example.test/auth/oidc/callback",
      },
      ...call(config),
    })).rejects.toThrow(/planned module variable values changed/i);
    expect(writes).toBe(0);
  });

  test("requires the Capsule installing Principal", async () => {
    const config = repositoryOidcInstallConfig();
    const capsule = oidcCapsule("active", "");
    const materializer = createOidcMaterializer({
      config: () => config,
      capsule: () => capsule,
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          throw new Error("must not write");
        },
      },
    });

    await expect(materializer.materialize({
      phase: "plan",
      ...call(config, capsule),
    })).rejects.toThrow(/installing Principal is missing/i);
  });

  test("retires the exact client idempotently only after terminal destroy", async () => {
    const config = repositoryOidcInstallConfig();
    const accounts = new InMemoryAccountsStore();
    let capsule = oidcCapsule();
    const revoked: string[] = [];
    const materializer = createOidcMaterializer({
      config: () => config,
      capsule: () => capsule,
      accounts: {
        async findOidcClient(clientId) {
          return accounts.findOidcClient(clientId);
        },
        async findOidcClientForCapsule(capsuleId) {
          return accounts.findOidcClientForCapsule(capsuleId);
        },
        async saveOidcClient(record) {
          accounts.saveOidcClient(record);
        },
        async revokeOidcClient(clientId) {
          revoked.push(clientId);
          accounts.revokeOidcClient(clientId);
        },
      },
    });
    const planned = await materializer.materialize({
      phase: "plan",
      ...call(config, capsule),
    });
    await materializer.materialize({
      phase: "apply",
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      ...call(config, capsule),
    });
    const clientId = planned!.variables.takosumi_accounts_client_id as string;
    const retirement = () => ({
      expectedDigest: planned!.digest,
      plannedVariables: planned!.variables,
      ...call(config, capsule),
    });

    await expect(materializer.retire(retirement())).rejects.toThrow(/terminal/i);
    capsule = oidcCapsule("destroyed");
    await materializer.retire(retirement());
    await materializer.retire(retirement());
    expect(revoked).toEqual([clientId, clientId]);
    expect(accounts.findOidcClient(clientId)).toBeUndefined();
  });
});
