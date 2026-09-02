// takos-secret-scan: synthetic — every value here is a literal fixture string
// or randomly sealed in memory; none is a credential.
//
// The contract this file pins: a Capsule whose manifest requests BOTH a
// generated secret and binding-delivered `identity.oidc` must receive one map
// carrying all five names. Yurucommu is the real case — its Takoform module
// declares exactly those five in `required_sensitive_vars`, and both the Host
// and the provider refuse a map whose names differ from that declaration — so
// the manifest itself is the fixture rather than a hand-written profile.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PlaceholderSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import {
  compileRepositoryInstallUx,
  DEFAULT_REPOSITORY_INSTALL_UX_ALLOWED_REQUIREMENT_KINDS,
} from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createRuntimeInputMaterializer,
  runtimeInputProviderInstance,
  type RuntimeInputOidcClientSource,
  type RuntimeInputOidcRequest,
} from "../../../../core/domains/deploy-control/runtime_input_materializer.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

/** The five names Yurucommu's Takoform WorkerVersion declares. */
const YURUCOMMU_SENSITIVE_VARS = [
  "ENCRYPTION_KEY",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_OWNER_SUB",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
];

const PROVIDER_INSTANCE = runtimeInputProviderInstance({
  moduleLocalName: "takoform",
});

const OIDC_VALUES: Readonly<Record<string, string>> = {
  TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.takosumi.test",
  TAKOSUMI_ACCOUNTS_CLIENT_ID: "tko_yurucommu_fixture_client_identifier",
  TAKOSUMI_ACCOUNTS_OWNER_SUB: "tsub_yurucommu_fixture_owner_subject",
  TAKOSUMI_ACCOUNTS_REDIRECT_URI:
    "https://yurucommu.example.test/api/auth/callback/takos",
};

/**
 * The real Yurucommu manifest, compiled the way an install does, so the name
 * set under test is the one the repository actually publishes.
 */
async function yurucommuTakoformProfile() {
  const document = JSON.parse(
    await readFile(
      new URL("../../../fixtures/yurucommu/takosumi.json", import.meta.url),
      "utf8",
    ),
  ) as RepositoryManifestDocument;
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: "caprep_yurucommu",
    sourceId: "src_yurucommu",
    sourceSnapshotId: "snap_yurucommu",
    modulePath: "deploy/takoform",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: ["project_name", "runtime_lane"],
    rootModuleVariableDeclarations: [
      { name: "project_name", type: "string", hasDefault: true },
      { name: "runtime_lane", type: "string", hasDefault: true },
    ],
    rootModuleOutputs: [
      { name: "launch_url", sensitive: false, ephemeral: false },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  const result = compileRepositoryInstallUx({
    document,
    sourceSnapshotId: "snap_yurucommu",
    modulePath: "deploy/takoform",
    compatibilityReport,
    capsuleName: "Yurucommu",
    workspaceId: "workspace_abcdef123456",
    policy: {
      allowedRequirementKinds:
        DEFAULT_REPOSITORY_INSTALL_UX_ALLOWED_REQUIREMENT_KINDS,
      allowedOidcScopes: ["openid", "profile", "email"],
      allowedInterfacePermissions: ["ui.open"],
      allowedInterfaceDeliveryTypes: ["none"],
      allowedInterfaceBindingProfiles: [
        { permissions: ["ui.open"], deliveryType: "none" },
      ],
    },
  });
  if (!result.ok) {
    throw new Error(
      `the Yurucommu manifest no longer compiles: ${result.diagnostic.code}`,
    );
  }
  return result.compiled.runtimeBindingMaterialization;
}

function recordingOidcSource(): RuntimeInputOidcClientSource & {
  readonly requests: RuntimeInputOidcRequest[];
  readonly materialized: RuntimeInputOidcRequest[];
} {
  const requests: RuntimeInputOidcRequest[] = [];
  const materialized: RuntimeInputOidcRequest[] = [];
  return {
    requests,
    materialized,
    async generation(request) {
      requests.push(request);
      return "sha256:fixture-oidc-generation";
    },
    async materialize(request) {
      requests.push(request);
      materialized.push(request);
      return {
        generation: "sha256:fixture-oidc-generation",
        values: { ...OIDC_VALUES },
      };
    },
  };
}

async function fixture(options: {
  readonly runtimeBindingMaterialization: unknown;
  readonly oidcClient?: RuntimeInputOidcClientSource;
}) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    installConfig: {
      runtimeBindingMaterialization:
        options.runtimeBindingMaterialization as never,
    },
  });
  const materializer = createRuntimeInputMaterializer({
    store,
    crypto: new PlaceholderSecretBoundaryCrypto(),
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
    ...(options.oidcClient ? { oidcClient: options.oidcClient } : {}),
  });
  const authority = {
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    installConfigId: seeded.installConfig.id,
  };
  return {
    store,
    seeded,
    materializer,
    authority,
    request: { ...authority, providerInstance: PROVIDER_INSTANCE },
  };
}

test("the Yurucommu profile names every binding its Worker Version requires", async () => {
  const profile = await yurucommuTakoformProfile();
  // The compiled profile is what the DB stores; the two halves of the name set
  // live in different members and only the materializer joins them.
  expect(profile).toEqual({
    contract: "takosumi.runtime-binding-profile/v2",
    generatedSecrets: [
      { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
    ],
    oidcClient: {
      issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
      callbackPath: "/api/auth/callback/takos",
      scopes: ["openid", "profile", "email"],
    },
  });

  const oidcClient = recordingOidcSource();
  const { materializer, authority } = await fixture({
    runtimeBindingMaterialization: profile,
    oidcClient,
  });
  const resolved = await materializer.profile(authority);
  expect([...resolved.names]).toEqual(YURUCOMMU_SENSITIVE_VARS);
  // The value-free profile never consults the value authority.
  expect(oidcClient.requests).toHaveLength(0);
});

test("apply delivers the five values, with the OIDC half sourced through the port", async () => {
  const profile = await yurucommuTakoformProfile();
  const oidcClient = recordingOidcSource();
  const { materializer, request, store } = await fixture({
    runtimeBindingMaterialization: profile,
    oidcClient,
  });

  const nonce = await materializer.nonce(request);
  const bundle = await materializer.materialize({ ...request, phase: "apply" });
  const dispatch = bundle.toRunnerDispatch();

  expect([...dispatch.names]).toEqual(YURUCOMMU_SENSITIVE_VARS);
  expect(Object.keys(dispatch.values).sort()).toEqual(YURUCOMMU_SENSITIVE_VARS);
  expect(dispatch.nonce).toBe(nonce);
  // The OIDC half is exactly what the port returned; the generated half is
  // sealed randomness this lane owns.
  for (const [name, value] of Object.entries(OIDC_VALUES)) {
    expect(dispatch.values[name]).toBe(value);
  }
  expect(dispatch.values.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/u);
  expect(oidcClient.materialized).toHaveLength(1);
  expect(oidcClient.materialized[0]).toEqual({
    profileContract: "takosumi.runtime-binding-profile/v2",
    workspaceId: request.workspaceId,
    capsuleId: request.capsuleId,
    installConfigId: request.installConfigId,
    bindings: profile!.oidcClient!,
  });

  // Only the generated secret is sealed; an OIDC value is one Accounts
  // registration and must never gain a second at-rest copy here.
  const sealed = await store.getSecretBlob(`runtime_input_${request.capsuleId}`);
  expect(sealed).toBeDefined();
  const serialized = JSON.stringify(sealed);
  for (const value of Object.values(dispatch.values)) {
    expect(serialized).not.toContain(value);
  }
});

test("the OIDC generation is part of the nonce and rotates it on its own", async () => {
  const profile = await yurucommuTakoformProfile();
  let generation = "sha256:generation-a";
  const oidcClient: RuntimeInputOidcClientSource = {
    async generation() {
      return generation;
    },
    async materialize() {
      return { generation, values: { ...OIDC_VALUES } };
    },
  };
  const { materializer, request } = await fixture({
    runtimeBindingMaterialization: profile,
    oidcClient,
  });
  const before = await materializer.nonce(request);
  // A moved registration — a new public origin, a rotated Accounts authority —
  // must rotate the provider's apply-idempotency identity exactly like
  // re-sealed material would.
  generation = "sha256:generation-b";
  expect(await materializer.nonce(request)).not.toBe(before);
  expect(
    (await materializer.materialize({ ...request, phase: "apply" })).nonce,
  ).toBe(await materializer.nonce(request));
});

test("a profile that delivers OIDC without a configured source fails closed", async () => {
  const profile = await yurucommuTakoformProfile();
  const { materializer, authority, request } = await fixture({
    runtimeBindingMaterialization: profile,
  });
  // The name set is still the truth about what this Capsule needs; only the
  // values are unavailable, so plan stops before anything is dispatched.
  expect([...(await materializer.profile(authority)).names]).toEqual(
    YURUCOMMU_SENSITIVE_VARS,
  );
  await expect(materializer.nonce(request)).rejects.toThrow(
    "no OIDC client source is configured",
  );
  await expect(
    materializer.materialize({ ...request, phase: "apply" }),
  ).rejects.toThrow("no OIDC client source is configured");
});

test("a port that answers about a different grant is refused", async () => {
  const profile = await yurucommuTakoformProfile();
  const { materializer, request } = await fixture({
    runtimeBindingMaterialization: profile,
    oidcClient: {
      async generation() {
        return "sha256:fixture-oidc-generation";
      },
      async materialize() {
        return {
          generation: "sha256:fixture-oidc-generation",
          values: {
            ...OIDC_VALUES,
            TAKOSUMI_ACCOUNTS_OWNER_SUB: undefined as unknown as string,
          },
        };
      },
    },
  });
  await expect(
    materializer.materialize({ ...request, phase: "apply" }),
  ).rejects.toThrow("runtime input OIDC values differ from their profile");
});

test("a profile without OIDC binding delivery keeps the generated-secret set", async () => {
  const oidcClient = recordingOidcSource();
  const { materializer, authority, request } = await fixture({
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v2",
      generatedSecrets: [
        { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
      ],
    },
    oidcClient,
  });
  expect([...(await materializer.profile(authority)).names]).toEqual([
    "ENCRYPTION_KEY",
  ]);
  const dispatch = (
    await materializer.materialize({ ...request, phase: "apply" })
  ).toRunnerDispatch();
  expect([...dispatch.names]).toEqual(["ENCRYPTION_KEY"]);
  expect(Object.keys(dispatch.values)).toEqual(["ENCRYPTION_KEY"]);
  // A configured port stays untouched by a profile that asks nothing of it, so
  // no Accounts read or registration happens for such a Capsule.
  expect(oidcClient.requests).toHaveLength(0);
});
