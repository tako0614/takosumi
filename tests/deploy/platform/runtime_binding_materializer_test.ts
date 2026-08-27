import { describe, expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { OidcClientRecord } from "../../../accounts/service/src/store.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import { validateOidcLiveGrant } from "../../../accounts/service/src/oidc-live-grant.ts";
import {
  createTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingAccountsLedger,
  type RuntimeBindingControlLedger,
} from "../../../deploy/platform/runtime_binding_materializer.ts";
import {
  createTakosumiAccountsOidcModuleVariableMaterializer,
  type AccountsOidcModuleVariableAccountsLedger,
  type AccountsOidcModuleVariableControlLedger,
} from "../../../deploy/platform/accounts_oidc_module_variable_materializer.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const PAIRWISE_SECRET = "pairwise-secret-with-at-least-32-bytes";
const DERIVATION_KEY = "runtime-secret-with-at-least-32-bytes";
const PROFILE_V1 = "takosumi.runtime-binding-profile/v1";
const PROFILE_V2 = "takosumi.runtime-binding-profile/v2";
const RUNTIME_BINDINGS = [
  "ENCRYPTION_KEY",
  "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_OWNER_SUB",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
] as const;

function runtimeBindingInstallConfig(
  overrides: Partial<InstallConfig> = {},
  profileContract: typeof PROFILE_V1 | typeof PROFILE_V2 = PROFILE_V1,
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
      contract: profileContract,
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
  input: {
    readonly epoch?: number;
    readonly currentConfig?: () => InstallConfig | undefined;
  } = {},
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
        projectId: "project_1",
        name: "Legacy private app",
        slug: "legacy-private-app",
        sourceId: "source_1",
        installConfigId: config.id,
        installingPrincipalId: "tsub_owner",
        environment: "staging",
        currentStateGeneration: 0,
        status: "active",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
    },
    async getInstallConfig() {
      return input.currentConfig?.() ?? config;
    },
    async getCapsuleExecutionAuthorityEpoch() {
      return input.epoch ?? 7;
    },
  };
}

function noAccountsAccess(): RuntimeBindingAccountsLedger {
  return {
    async findOidcClient() {
      throw new Error("read-only materialization must not read Accounts");
    },
    async findOidcClientForCapsule() {
      throw new Error("read-only materialization must not read Accounts");
    },
    async saveOidcClient() {
      throw new Error("read-only materialization must not write Accounts");
    },
  };
}

function recordingAccountsStore(input: { readonly loseFirstAck?: boolean } = {}) {
  const store = new InMemoryAccountsStore();
  let writes = 0;
  let loseFirstAck = input.loseFirstAck ?? false;
  const accounts: RuntimeBindingAccountsLedger = {
    async findOidcClient(clientId) {
      return store.findOidcClient(clientId);
    },
    async findOidcClientForCapsule(capsuleId) {
      return store.findOidcClientForCapsule(capsuleId);
    },
    async saveOidcClient(record) {
      store.saveOidcClient(record);
      writes += 1;
      if (loseFirstAck) {
        loseFirstAck = false;
        throw new Error("simulated lost Accounts acknowledgement");
      }
    },
  };
  return { accounts, store, writes: () => writes };
}

function runtimeBindingCall(
  phase: "plan" | "apply" | "destroy" = "apply",
  overrides: Partial<{
    readonly publicOrigin: string;
    readonly bindings: readonly string[];
  }> = {},
) {
  return {
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
    bindings: RUNTIME_BINDINGS,
    ...overrides,
  } as const;
}

function createRuntimeBindingMaterializer(input: {
  readonly control?: RuntimeBindingControlLedger;
  readonly accounts?: RuntimeBindingAccountsLedger;
} = {}) {
  return createTakosumiRuntimeBindingMaterializer({
    control: input.control ?? runtimeBindingControl(),
    accounts: input.accounts ?? noAccountsAccess(),
    issuer: "https://app.takosumi.com",
    pairwiseSubjectSecret: PAIRWISE_SECRET,
    derivationKey: DERIVATION_KEY,
    clock: () => NOW,
  });
}

describe("Takosumi runtime binding materializer", () => {
  test("derives the exact DB-owned values read-only in every provider phase", async () => {
    const config = runtimeBindingInstallConfig();
    const original = structuredClone(config);
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
    });

    const outcomes = await Promise.all(
      (["plan", "apply", "destroy"] as const).map((phase) =>
        materializer.materializeRuntimeBindings(runtimeBindingCall(phase))
      ),
    );

    expect(Object.keys(outcomes[0]!.values).sort()).toEqual(
      [...RUNTIME_BINDINGS].sort(),
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
      createRuntimeBindingMaterializer({
        control: runtimeBindingControl(config),
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

  test("commits the exact OIDC registration only after an explicit Apply commit", async () => {
    const config = runtimeBindingInstallConfig({}, PROFILE_V2);
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
      accounts: recorded.accounts,
    });
    const call = runtimeBindingCall("apply");

    const materialized = await materializer.materializeRuntimeBindings(call);
    expect(materialized.values.TAKOSUMI_ACCOUNTS_CLIENT_ID).toMatch(
      /^tko_[A-Za-z0-9_-]{43}$/u,
    );
    expect(recorded.writes()).toBe(0);
    expect(
      recorded.store.findOidcClient(
        materialized.values.TAKOSUMI_ACCOUNTS_CLIENT_ID!,
      ),
    ).toBeUndefined();

    await materializer.commitRuntimeBindings(call);

    expect(recorded.writes()).toBe(1);
    expect(
      recorded.store.findOidcClient(
        materialized.values.TAKOSUMI_ACCOUNTS_CLIENT_ID!,
      ),
    ).toMatchObject({
      capsuleId: "cap_1",
      issuerUrl: "https://app.takosumi.com",
      redirectUris: [
        "https://legacy-app.example.test/auth/legacy/callback",
      ],
      allowedScopes: ["openid", "profile", "email"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "none",
      activationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  test("keeps upload-failure rollback read-only before explicit commit", async () => {
    const config = runtimeBindingInstallConfig({}, PROFILE_V2);
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
      accounts: recorded.accounts,
    });
    const call = runtimeBindingCall("apply");

    await materializer.materializeRuntimeBindings(call);
    await materializer.rollbackRuntimeBindings({
      request: call.request,
      rollbackReceipt: "worker-version-upload-failed",
    });

    expect(recorded.writes()).toBe(0);
  });

  test("retries an Apply commit idempotently after a duplicate or lost acknowledgement", async () => {
    const config = runtimeBindingInstallConfig({}, PROFILE_V2);
    const recorded = recordingAccountsStore({ loseFirstAck: true });
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
      accounts: recorded.accounts,
    });
    const call = runtimeBindingCall("apply");

    await expect(materializer.commitRuntimeBindings(call)).rejects.toThrow(
      /lost Accounts acknowledgement/i,
    );
    expect(recorded.writes()).toBe(1);

    await materializer.commitRuntimeBindings(call);
    await materializer.commitRuntimeBindings(call);
    expect(recorded.writes()).toBe(1);
  });

  test("refuses non-Apply commit and current profile drift without Accounts mutation", async () => {
    let current = runtimeBindingInstallConfig({}, PROFILE_V2);
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(current, {
        currentConfig: () => current,
      }),
      accounts: recorded.accounts,
    });

    await expect(
      materializer.commitRuntimeBindings(runtimeBindingCall("plan")),
    ).rejects.toThrow(/Apply/i);
    await expect(
      materializer.commitRuntimeBindings(runtimeBindingCall("destroy")),
    ).rejects.toThrow(/Apply/i);

    await materializer.materializeRuntimeBindings(runtimeBindingCall("apply"));
    current = runtimeBindingInstallConfig({
      runtimeBindingMaterialization: {
        contract: PROFILE_V2,
        generatedSecrets: [{
          binding: "DIFFERENT_KEY",
          bytes: 32,
          encoding: "hex",
        }],
      },
      updatedAt: "2026-08-25T12:00:01.000Z",
    }, PROFILE_V2);
    await expect(
      materializer.commitRuntimeBindings(runtimeBindingCall("apply")),
    ).rejects.toThrow(/DB-owned profile/i);
    expect(recorded.writes()).toBe(0);
  });

  test("refuses authority drift between commit confirmation reads", async () => {
    const config = runtimeBindingInstallConfig({}, PROFILE_V2);
    const drifted = runtimeBindingInstallConfig({
      updatedAt: "2026-08-25T12:00:01.000Z",
    }, PROFILE_V2);
    let configReads = 0;
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config, {
        currentConfig: () => configReads++ === 0 ? config : drifted,
      }),
      accounts: recorded.accounts,
    });

    await expect(
      materializer.commitRuntimeBindings(runtimeBindingCall("apply")),
    ).rejects.toThrow(/authority changed during confirmation/i);
    expect(recorded.writes()).toBe(0);
  });

  test("commits no Accounts mutation for a generated-secret-only profile", async () => {
    const config = runtimeBindingInstallConfig({
      installExperience: undefined,
      runtimeBindingMaterialization: {
        contract: PROFILE_V2,
        generatedSecrets: [{
          binding: "ENCRYPTION_KEY",
          bytes: 32,
          encoding: "hex",
        }],
      },
    }, PROFILE_V2);
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
      accounts: recorded.accounts,
    });
    const call = runtimeBindingCall("apply", {
      bindings: ["ENCRYPTION_KEY"],
    });

    await expect(materializer.commitRuntimeBindings(call)).resolves.toBeUndefined();
    expect(recorded.writes()).toBe(0);
  });

  test("saves the current epoch digest accepted by live-grant validation", async () => {
    const config = runtimeBindingInstallConfig({}, PROFILE_V2);
    const capsule = {
      id: "cap_1",
      workspaceId: "ws_1",
      name: "Legacy private app",
      installConfigId: config.id,
      status: "active",
    } as const;
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config, { epoch: 7 }),
      accounts: recorded.accounts,
    });
    const call = runtimeBindingCall("apply");
    const materialized = await materializer.materializeRuntimeBindings(call);
    await materializer.commitRuntimeBindings(call);
    const clientId = materialized.values.TAKOSUMI_ACCOUNTS_CLIENT_ID!;
    const client = recorded.store.findOidcClient(clientId)!;
    const operations = {
      capsules: {
        getCapsule: async () => capsule,
        getInstallConfig: async () => config,
        getCapsuleExecutionAuthorityEpoch: async () => 7,
      },
      workspaces: {
        getWorkspace: async () => ({
          id: "ws_1",
          ownerUserId: "tsub_owner",
        }),
      },
      members: { listMembers: async () => [] },
    } as unknown as ControlPlaneOperations;

    await expect(validateOidcLiveGrant({
      store: recorded.store,
      operations,
      client,
      scope: "openid profile email",
      takosumiSubject: "tsub_owner",
      capsuleId: "cap_1",
      workspaceId: "ws_1",
    })).resolves.toEqual({
      ok: true,
      capsuleId: "cap_1",
      capsuleName: "Legacy private app",
      workspaceId: "ws_1",
      role: "owner",
    });
  });

  test("keeps v1 commit read-only for compatibility", async () => {
    const config = runtimeBindingInstallConfig({}, PROFILE_V1);
    const recorded = recordingAccountsStore();
    const materializer = createRuntimeBindingMaterializer({
      control: runtimeBindingControl(config),
      accounts: recorded.accounts,
    });

    await materializer.commitRuntimeBindings(runtimeBindingCall("apply"));

    expect(recorded.writes()).toBe(0);
  });

  test("derives v2 secret and OIDC identity Capsule-stably across InstallConfig replacement", async () => {
    const firstConfig = runtimeBindingInstallConfig({
      id: "icfg_runtime_binding_first",
    }, PROFILE_V2);
    const secondConfig = runtimeBindingInstallConfig({
      id: "icfg_runtime_binding_second",
    }, PROFILE_V2);
    const call = runtimeBindingCall("plan");

    const first = await createRuntimeBindingMaterializer({
      control: runtimeBindingControl(firstConfig),
    }).materializeRuntimeBindings(call);
    const second = await createRuntimeBindingMaterializer({
      control: runtimeBindingControl(secondConfig),
    }).materializeRuntimeBindings(call);

    expect(second.values.ENCRYPTION_KEY).toBe(first.values.ENCRYPTION_KEY);
    expect(second.values.TAKOSUMI_ACCOUNTS_CLIENT_ID).toBe(
      first.values.TAKOSUMI_ACCOUNTS_CLIENT_ID,
    );
    expect(second.values.TAKOSUMI_ACCOUNTS_OWNER_SUB).toBe(
      first.values.TAKOSUMI_ACCOUNTS_OWNER_SUB,
    );
  });

  test("preserves the exact v1 config-scoped derivation", async () => {
    const firstConfig = runtimeBindingInstallConfig({
      id: "icfg_runtime_binding_first",
    }, PROFILE_V1);
    const secondConfig = runtimeBindingInstallConfig({
      id: "icfg_runtime_binding_second",
    }, PROFILE_V1);
    const call = runtimeBindingCall("plan");

    const first = await createRuntimeBindingMaterializer({
      control: runtimeBindingControl(firstConfig),
    }).materializeRuntimeBindings(call);
    const second = await createRuntimeBindingMaterializer({
      control: runtimeBindingControl(secondConfig),
    }).materializeRuntimeBindings(call);

    expect(first.values).toMatchObject({
      ENCRYPTION_KEY:
        "ea8ed4859d0e3c2c6ce9bf09849e10641f62710109287ec39eb9fa128b9557be",
      TAKOSUMI_ACCOUNTS_CLIENT_ID:
        "tko_724UIrZAPne2bHZdrbQv3MeI5l1oYqY1KVuocPeTqPs",
      TAKOSUMI_ACCOUNTS_OWNER_SUB:
        "tsub_ySEHgIbTe99wY8NWtBxaRJJ868Sz4GZq",
    });
    expect(second.values.ENCRYPTION_KEY).not.toBe(first.values.ENCRYPTION_KEY);
    expect(second.values.TAKOSUMI_ACCOUNTS_CLIENT_ID).not.toBe(
      first.values.TAKOSUMI_ACCOUNTS_CLIENT_ID,
    );
    expect(second.values.TAKOSUMI_ACCOUNTS_OWNER_SUB).not.toBe(
      first.values.TAKOSUMI_ACCOUNTS_OWNER_SUB,
    );
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
