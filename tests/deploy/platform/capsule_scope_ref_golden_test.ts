// takos-secret-scan: synthetic — fixed test keys; the asserted values are HMAC
// outputs of those keys, pinned to prove they never move.
/**
 * TASK-0118 Phase 9, stage 9.0: every durable value Takosumi derives for a
 * Capsule reads the Capsule's frozen `scopeRef` instead of its Workspace id.
 *
 * GOLDEN holds the values the unmodified code produced on origin/main
 * `2545cfefa` for one fixed Capsule (Workspace `ws_golden_scope`, Capsule
 * `cap_golden`). Each test derives them again for three spellings of that
 * Capsule and requires byte-identical results:
 *
 * - `legacy`: stored before stage 9.0, no `scopeRef` (derives from Workspace);
 * - `backfilled`: `scopeRef` copied from the Workspace id by the backfill;
 * - `workspaceMoved`: the authority Workspace id has changed (as it will when
 *   Workspace is removed) while `scopeRef` keeps the frozen value. Identical
 *   values here prove the derivations follow `scopeRef`, not the Workspace.
 */
import { describe, expect, test } from "bun:test";
import {
  capsuleScopeRef,
  capsuleWithScopeRef,
  type Capsule,
} from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { oidcClientActivationDigest } from "../../../accounts/service/src/oidc-activation.ts";
import {
  createTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingAccountsLedger,
  type RuntimeBindingControlLedger,
} from "../../../deploy/platform/runtime_binding_materializer.ts";
import { PlaceholderSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  createRuntimeInputMaterializer,
  runtimeInputDerivedValueSource,
  runtimeInputProviderInstance,
} from "../../../core/domains/deploy-control/runtime_input_materializer.ts";
import { createRuntimeSecretFileMaterializer } from "../../../core/domains/deploy-control/runtime_secret_file_materializer.ts";
import { destroyRuntimeInputNonce } from "../../../core/domains/deploy-control/run-engine/run_engine.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import { createTakosumiAccountsOidcModuleVariableMaterializer } from "../../../deploy/platform/accounts_oidc_module_variable_materializer.ts";
import { createTakosumiRuntimeInputOidcClientSource } from "../../../deploy/platform/runtime_input_oidc_client_source.ts";
import {
  capsulePublicOriginIdempotencyKey,
  capsulePublicOriginRequestedLabel,
} from "../../../deploy/platform/platform_extension_provider_credentials.ts";
import { mergeInstallContextVariables } from "../../../core/domains/deploy-control/validation.ts";
import { workspaceSlugSuffix } from "../../../core/domains/capsules/repository_install_ux_compiler.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const PAIRWISE_SECRET = "pairwise-secret-with-at-least-32-bytes";
const DERIVATION_KEY = "runtime-secret-with-at-least-32-bytes";
const SCOPE = "ws_golden_scope";
const MOVED_WORKSPACE = "ws_after_workspace_removal";
const CAP = "cap_golden";
const ICFG = "icfg_golden";
const INSTANCE = runtimeInputProviderInstance({ moduleLocalName: "takoform" });
const V1 = "takosumi.runtime-binding-profile/v1";
const V2 = "takosumi.runtime-binding-profile/v2";

/** Captured from the unmodified code on origin/main 2545cfefa. */
const GOLDEN = {
  v1: {
    values: {
      ENCRYPTION_KEY: "ed788dde1d4f343362dcafce8c9a751bc8e61309eb0bc57eab292d280b833357",
      SIGNING_KEY: "9450cf23e2d9b7867f07543acd896fe6bf11f6aede6130ca250a281bc3945d4c",
      OIDC_ISSUER: "https://app.takosumi.com",
      OIDC_CLIENT_ID: "tko_-J6MnNOcURc7qmmx17clcAIUlWwZkKja0Rv4PO5KiA0",
      OIDC_OWNER_SUB: "tsub_9ptMJYUCD3AojVLGkQcuKceKf4qRj7X6",
      OIDC_REDIRECT_URI: "https://golden.example.test/auth/cb",
    },
    nonce: "VpnbFawUOOI3G5W84Yg67M9Esy5vZpy7If6I71SwvDY",
    activation: "sha256:68397cf5dcef77bc41c6dc1d9a30c99bd17e7afc4e509c0b41871791490617be",
    sealedAad: "{\"capsuleId\":\"cap_golden\",\"contract\":\"takosumi.runtime-provider-input/v1\",\"ownerRef\":\"runtime_input_cap_golden\",\"profileDigest\":\"sha256:d3910bab0820069257c86cb4855e76e62b9c70591653529a24057bc167956e38\",\"workspaceId\":\"ws_golden_scope\"}",
  },
  v2: {
    values: {
      ENCRYPTION_KEY: "970f262e30cab7227ab55cc74d8513bea50f76eba9dea49fad394f70fdea7c52",
      SIGNING_KEY: "22b814af4ba026c1e06c25c2c85294abe53ec612ab4e17eff58fa6bdd8a74fcc",
      OIDC_ISSUER: "https://app.takosumi.com",
      OIDC_CLIENT_ID: "tko_9sah_LCFCL_30Hm0OyFZz_suwHYX9hTSPw48bbB7fT4",
      OIDC_OWNER_SUB: "tsub_b3ZOKe2SWBLd4BKLSWu5GqtmfhzNrhY6",
      OIDC_REDIRECT_URI: "https://golden.example.test/auth/cb",
    },
    nonce: "zf8y6lhG9-Y50wPfufeHD6w_7Bs6mglE2-xkdcRpalI",
    activation: "sha256:60fb16246358aa2b3b7104bd66571e19763e77187df8306bfc23a22c41bc0942",
    sealedAad: "{\"capsuleId\":\"cap_golden\",\"contract\":\"takosumi.runtime-provider-input/v1\",\"ownerRef\":\"runtime_input_cap_golden\",\"profileDigest\":\"sha256:a87374850902070a7fcf9e04156237d9d9b692a166e0c3509ec59293ce70e5e8\",\"workspaceId\":\"ws_golden_scope\"}",
  },
  secretFileAad: "{\"capsuleId\":\"cap_golden\",\"contract\":\"takosumi.runtime-secret-file/v1\",\"ownerRef\":\"runtime_secret_file_cap_golden\",\"profileDigest\":\"sha256:4f981672c556939ac25b23eb745ac49e7218a0613097a9a83707985e93a770d0\",\"workspaceId\":\"ws_golden_scope\"}",
  repositoryOidc: {
    planDigest: "sha256:80ddd77bea8acf394f0b5cdc01d4ced33cad1ce0702deb9e079e0351b0c14980",
    variables: {
      takosumi_accounts_url: "https://app.takosumi.com",
      takosumi_accounts_issuer_url: "https://app.takosumi.com",
      takosumi_accounts_client_id: "tko_iqYFqGctcuDQKrHGiiuFZYy64Utcypf40knp0X6X1Qs",
      takosumi_accounts_redirect_uri: "https://golden.example.test/auth/oidc/callback",
    },
    activation: "sha256:32aa7dc61572f63ecac5454893d812b62c2647c00c68d56b9cf15fc89ecbaae1",
  },
  publicOriginLabel: "golden-app-ws-gol",
  publicOriginKey: "endpoint_request_a724d3f492dbb08b607b5dda3ae6a1db777fc54e63ea1b7bc72300f247f6869c",
  installContext: { app_workspace_id: "ws_golden_scope", nested: { capsule: "cap_golden" } },
  slugSuffix: "ws-gol",
  destroyNonce: "f90wSqRZogLL2Op8fwLfX70CbHhVGpUiPFDHLq0Px2o",
} as const;

interface Variant {
  readonly name: "legacy" | "backfilled" | "workspaceMoved";
  /** Authority Workspace id of the Capsule and its InstallConfig. */
  readonly workspaceId: string;
  readonly scopeRef?: string;
}

const VARIANTS: readonly Variant[] = [
  { name: "legacy", workspaceId: SCOPE },
  { name: "backfilled", workspaceId: SCOPE, scopeRef: SCOPE },
  { name: "workspaceMoved", workspaceId: MOVED_WORKSPACE, scopeRef: SCOPE },
];

function profile(contract: string) {
  return {
    contract,
    generatedSecrets: [
      { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
      { binding: "SIGNING_KEY", bytes: 32, encoding: "hex" },
    ],
    oidcClient: {
      issuerBinding: "OIDC_ISSUER",
      clientIdBinding: "OIDC_CLIENT_ID",
      ownerSubjectBinding: "OIDC_OWNER_SUB",
      redirectUriBinding: "OIDC_REDIRECT_URI",
      callbackPath: "/auth/cb",
      scopes: ["openid", "profile"],
    },
  };
}

function config(contract: string, variant: Variant): InstallConfig {
  return {
    id: ICFG,
    workspaceId: variant.workspaceId,
    name: "Golden",
    variableMapping: {},
    installExperience: {
      projections: [{
        kind: "oidc_client",
        variables: {},
        callbackPath: "/auth/cb",
        scopes: ["openid", "profile"],
      }],
    },
    runtimeBindingMaterialization: profile(contract),
    outputAllowlist: {},
    policy: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as unknown as InstallConfig;
}

function capsule(cfg: InstallConfig, variant: Variant): Capsule {
  return {
    id: CAP,
    workspaceId: variant.workspaceId,
    ...(variant.scopeRef !== undefined ? { scopeRef: variant.scopeRef } : {}),
    projectId: `prj_default_${variant.workspaceId}`,
    name: "Golden App",
    slug: "golden-app",
    sourceId: "src_golden",
    installConfigId: cfg.id,
    installingPrincipalId: "tsub_golden",
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as Capsule;
}

function control(cfg: InstallConfig, variant: Variant): RuntimeBindingControlLedger {
  return {
    async resolveContext(request) {
      return {
        ok: true,
        context: {
          workspaceId: variant.workspaceId,
          capsuleId: CAP,
          runId: "run_golden",
          installingPrincipalId: "tsub_golden",
          phase: request.phase,
          lifecycleIntent: request.phase === "destroy" ? "destroy" : "provision",
        },
      };
    },
    async getCapsule() {
      return capsule(cfg, variant);
    },
    async getInstallConfig() {
      return cfg;
    },
    async getCapsuleExecutionAuthorityEpoch() {
      return 3;
    },
  };
}

function accounts() {
  const store = new InMemoryAccountsStore();
  const ledger: RuntimeBindingAccountsLedger = {
    findOidcClient: async (id) => store.findOidcClient(id),
    findOidcClientForCapsule: async (id) => store.findOidcClientForCapsule(id),
    saveOidcClient: async (record) => {
      store.saveOidcClient(record);
    },
  };
  return { ledger, store };
}

/** A memory control store holding the variant's Capsule and InstallConfig. */
async function seededStore(
  variant: Variant,
  runtimeBindingMaterialization: unknown,
  installExperience?: unknown,
) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: variant.workspaceId,
    capsuleId: CAP,
    installConfigId: ICFG,
    installConfig: {
      runtimeBindingMaterialization: runtimeBindingMaterialization as never,
      ...(installExperience ? { installExperience: installExperience as never } : {}),
    },
  });
  if (variant.scopeRef !== undefined) {
    await store.putCapsule({ ...seeded.capsule, scopeRef: variant.scopeRef });
  }
  const stored = await store.getCapsule(CAP);
  expect(stored?.workspaceId).toBe(variant.workspaceId);
  expect(stored?.scopeRef).toBe(variant.scopeRef);
  return { store, request: { workspaceId: variant.workspaceId, capsuleId: CAP, installConfigId: ICFG, providerInstance: INSTANCE } };
}

/**
 * The OIDC activation digest has two Workspace-shaped inputs. Its scope slot
 * reads `scopeRef` and never moves. It also digests the whole InstallConfig
 * record, and that record carries its own `workspaceId`: when the authority
 * Workspace moves, the InstallConfig content (and so this digest) moves with
 * it, independently of `scopeRef`. Stage 9.0 does not change that input; a
 * later stage must not rewrite stored InstallConfig records, or must
 * re-register the activation on the next Apply (see the 9.0 report).
 */
async function expectActivation(
  actual: string | undefined,
  golden: string,
  installConfig: InstallConfig,
  variant: Variant,
): Promise<void> {
  if (variant.workspaceId === SCOPE) {
    expect(actual).toBe(golden);
    return;
  }
  const digest = (scopeRef: string) =>
    oidcClientActivationDigest({
      scopeRef,
      capsuleId: CAP,
      executionAuthorityEpoch: 3,
      installConfig,
    });
  expect(actual).toBe(await digest(SCOPE));
  expect(actual).not.toBe(await digest(variant.workspaceId));
  expect(actual).not.toBe(golden);
}

describe("frozen scopeRef keeps every derived value byte-identical", () => {
  for (const variant of VARIANTS) {
    for (const [tag, contract] of [["v1", V1], ["v2", V2]] as const) {
      test(`${variant.name}: private runtime-binding lane secrets and OIDC client (${tag})`, async () => {
        const cfg = config(contract, variant);
        const platform = createTakosumiRuntimeBindingMaterializer({
          control: control(cfg, variant),
          accounts: accounts().ledger,
          issuer: "https://app.takosumi.com",
          pairwiseSubjectSecret: PAIRWISE_SECRET,
          derivationKey: DERIVATION_KEY,
          clock: () => NOW,
        });
        const resolved = await platform.materializeRuntimeBindings({
          request: {
            contract: "takosumi.runtime-bindings/v1",
            workspaceId: variant.workspaceId,
            capsuleId: CAP,
            runId: "run_golden",
            phase: "apply",
          },
          resourceName: "external_worker_version.app",
          scriptName: "golden-app",
          publicOrigin: "https://golden.example.test",
          bindings: ["ENCRYPTION_KEY", "SIGNING_KEY", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_OWNER_SUB", "OIDC_REDIRECT_URI"],
        } as never);
        expect(resolved.values).toEqual(GOLDEN[tag].values);
      });

      test(`${variant.name}: run-scoped derived lane values, nonce and OIDC activation (${tag})`, async () => {
        const cfg = config(contract, variant);
        const { store, request } = await seededStore(variant, cfg.runtimeBindingMaterialization, cfg.installExperience);
        const registered = accounts();
        const materializer = createRuntimeInputMaterializer({
          store,
          crypto: new PlaceholderSecretBoundaryCrypto(),
          values: runtimeInputDerivedValueSource(DERIVATION_KEY),
          clock: () => NOW,
          oidcClient: createTakosumiRuntimeInputOidcClientSource({
            control: {
              getCapsule: async () => capsule(cfg, variant),
              getInstallConfig: async () => cfg,
              getCapsuleExecutionAuthorityEpoch: async () => 3,
            },
            accounts: registered.ledger,
            issuer: "https://app.takosumi.com",
            pairwiseSubjectSecret: PAIRWISE_SECRET,
            derivationKey: DERIVATION_KEY,
            capsulePublicOrigin: async () => "https://golden.example.test",
            clock: () => NOW,
          }),
        });
        expect(await materializer.nonce(request)).toBe(GOLDEN[tag].nonce);
        const dispatch = (await materializer.materialize({ ...request, phase: "apply" })).toRunnerDispatch();
        expect(dispatch.values).toEqual(GOLDEN[tag].values);
        expect(dispatch.nonce).toBe(GOLDEN[tag].nonce);
        await expectActivation(
          (await registered.store.findOidcClientForCapsule(CAP))?.activationDigest,
          GOLDEN[tag].activation,
          cfg,
          variant,
        );
      });

      test(`${variant.name}: sealed runtime-input AAD opens the same generation (${tag})`, async () => {
        const cfg = config(contract, variant);
        const { store, request } = await seededStore(variant, {
          contract,
          generatedSecrets: (cfg.runtimeBindingMaterialization as { generatedSecrets: unknown }).generatedSecrets,
        });
        const sealed = createRuntimeInputMaterializer({
          store,
          crypto: new PlaceholderSecretBoundaryCrypto(),
          clock: () => NOW,
        });
        await sealed.nonce(request);
        const blob = await store.getSecretBlob(`runtime_input_${CAP}`);
        expect(blob?.aad).toBe(GOLDEN[tag].sealedAad);
        // The owner fence stays on the row's Workspace column (authority).
        expect(blob?.workspaceId).toBe(variant.workspaceId);
      });
    }

    test(`${variant.name}: runtime secret file AAD`, async () => {
      const { store } = await seededStore(variant, {
        contract: V1,
        runtimeSecretFile: {
          contract: "takosumi.runtime-secret-file/v1",
          envName: "GOLDEN_SECRETS_FILE",
          fileName: "golden.json",
          mode: 0o600,
          values: [{ kind: "random", name: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" }],
        },
      });
      await createRuntimeSecretFileMaterializer({
        store,
        crypto: new PlaceholderSecretBoundaryCrypto(),
        clock: () => NOW,
      }).materialize({
        workspaceId: variant.workspaceId,
        capsuleId: CAP,
        installConfigId: ICFG,
        phase: "post_apply",
      });
      expect((await store.getSecretBlob(`runtime_secret_file_${CAP}`))?.aad).toBe(GOLDEN.secretFileAad);
    });

    test(`${variant.name}: repository OIDC client id and activation`, async () => {
      const repoCfg = {
        ...config(V2, variant),
        id: "icfg_repo_golden",
        runtimeBindingMaterialization: undefined,
        internal: {
          reason: "per_install_overrides",
          sourceSnapshotId: "snap_golden",
          repositoryInstallUxDigest: `sha256:${"b".repeat(64)}`,
        },
        variableMapping: { public_url: "https://golden.example.test" },
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
              scopes: ["openid", "profile"],
            },
          ],
          repositoryInstallUx: { status: "accepted" },
        },
        policy: {
          repositoryInstallUx: {
            allowedInterfacePermissions: [],
            allowedOidcScopes: ["openid", "profile"],
          },
        },
      } as unknown as InstallConfig;
      const repoCapsule = { ...capsule(repoCfg, variant), installConfigId: repoCfg.id };
      const registered = accounts();
      const materializer = createTakosumiAccountsOidcModuleVariableMaterializer({
        control: {
          getCapsule: async () => repoCapsule,
          getInstallConfig: async () => repoCfg,
        },
        accounts: registered.ledger,
        issuer: "https://app.takosumi.com",
        pairwiseSubjectSecret: PAIRWISE_SECRET,
        clock: () => NOW,
      });
      const call = {
        capsule: repoCapsule,
        installConfig: repoCfg,
        resolvedProviderBindings: [],
        capsuleExecutionAuthorityEpoch: 3,
        variables: { public_url: "https://golden.example.test" },
      };
      const planned = (await materializer.materialize({ phase: "plan", ...call } as never)) as {
        readonly digest: string;
        readonly variables: Readonly<Record<string, string>>;
      };
      expect(planned.variables).toEqual(GOLDEN.repositoryOidc.variables);
      // The Plan-to-Apply digest also binds the authority Workspace id, so it
      // equals the golden value exactly while the Workspace has not moved.
      if (variant.workspaceId === SCOPE) {
        expect(planned.digest).toBe(GOLDEN.repositoryOidc.planDigest);
      }
      await materializer.materialize({
        phase: "apply",
        ...call,
        expectedDigest: planned.digest,
        plannedVariables: planned.variables,
      } as never);
      await expectActivation(
        (await registered.store.findOidcClientForCapsule(CAP))?.activationDigest,
        GOLDEN.repositoryOidc.activation,
        repoCfg,
        variant,
      );
    });

    test(`${variant.name}: public origin label and reservation key, install context, name suffix`, async () => {
      const subject = capsule(config(V2, variant), variant);
      expect(capsulePublicOriginRequestedLabel({
        capsule: subject,
        installConfig: { installExperience: undefined, variableMapping: {} } as never,
      })).toBe(GOLDEN.publicOriginLabel);
      expect(await capsulePublicOriginIdempotencyKey({ id: subject.id, scopeRef: capsuleScopeRef(subject) })).toBe(GOLDEN.publicOriginKey);
      // run_engine passes exactly this context to the module's install inputs.
      expect(mergeInstallContextVariables(
        {},
        { app_workspace_id: "workspace_id", "nested.capsule": "capsule_id" } as never,
        { workspaceId: capsuleScopeRef(subject), capsuleId: subject.id },
      )).toEqual(GOLDEN.installContext);
      // Re-adoption compiles `workspace_scoped_capsule_name` from this suffix.
      expect(workspaceSlugSuffix(capsuleScopeRef(subject))).toBe(GOLDEN.slugSuffix);
      expect(await destroyRuntimeInputNonce({
        scopeRef: capsuleScopeRef(subject),
        capsuleId: subject.id,
        providerInstance: "takoform",
        currentStateVersionId: "sv_golden",
        currentStateGeneration: 4,
      })).toBe(GOLDEN.destroyNonce);
      expect(await oidcClientActivationDigest({
        scopeRef: capsuleScopeRef(subject),
        capsuleId: CAP,
        executionAuthorityEpoch: 3,
        installConfig: config(V2, { name: "legacy", workspaceId: SCOPE }),
      })).toBe(GOLDEN.v2.activation);
    });
  }
});

test("backfilling scopeRef reopens the generation sealed before it without re-sealing", async () => {
  const legacy: Variant = { name: "legacy", workspaceId: SCOPE };
  const { store, request } = await seededStore(legacy, {
    contract: V2,
    generatedSecrets: [{ binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" }],
  });
  const materializer = createRuntimeInputMaterializer({
    store,
    crypto: new PlaceholderSecretBoundaryCrypto(),
    clock: () => NOW,
  });
  const nonce = await materializer.nonce(request);
  const sealed = await store.getSecretBlob(`runtime_input_${CAP}`);
  const values = (await materializer.materialize({ ...request, phase: "apply" })).toRunnerDispatch().values;
  // The operator backfill writes exactly the Workspace id.
  await store.putCapsule({ ...(await store.getCapsule(CAP))!, scopeRef: SCOPE });
  expect(await materializer.nonce(request)).toBe(nonce);
  expect(await store.getSecretBlob(`runtime_input_${CAP}`)).toEqual(sealed);
  expect((await materializer.materialize({ ...request, phase: "apply" })).toRunnerDispatch().values).toEqual(values);
});

describe("capsuleScopeRef", () => {
  test("falls back to the Workspace id only when no scope is stored", () => {
    expect(capsuleScopeRef({ workspaceId: "ws_1" })).toBe("ws_1");
    expect(capsuleScopeRef({ workspaceId: "ws_2", scopeRef: "ws_1" })).toBe("ws_1");
    expect(() => capsuleScopeRef({ workspaceId: "ws_1", scopeRef: "" })).toThrow("Capsule scopeRef is invalid");
    expect(() => capsuleScopeRef({ workspaceId: "ws_1", scopeRef: 7 as unknown as string })).toThrow("Capsule scopeRef is invalid");
  });

  test("record comparison treats a pre-9.0 row and its backfilled spelling as one Capsule", () => {
    const legacy = { id: "cap_1", workspaceId: "ws_1" };
    expect(capsuleWithScopeRef(legacy)).toEqual({ ...legacy, scopeRef: "ws_1" });
    const frozen = { id: "cap_1", workspaceId: "ws_2", scopeRef: "ws_1" };
    expect(capsuleWithScopeRef(frozen)).toBe(frozen);
  });
});
