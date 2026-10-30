// TASK-0118 Phase 9: drives the InstallConfig re-adoption and configuration
// plan routes for a Capsule whose frozen scopeRef differs from its live
// Workspace id. The golden test pins the leaf derivations; this pins that the
// routes hand them scopeRef, so reverting a handler to the Workspace id fails
// here.
import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { configurationTargetInstallConfigId } from "../../../../accounts/service/src/control/configuration-plans.ts";
import { reAdoptionTargetInstallConfigId } from "../../../../accounts/service/src/control/install-config-re-adoptions.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { RepositoryInstallUxInput } from "takosumi-contract/repository-manifest";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { workspaceSlugSuffix } from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  fakeProviderVault,
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const NOW = "2026-10-30T00:00:00.000Z";
/** `seedCapsuleModel` makes this account the Workspace owner. */
const SUBJECT = "user_test";
const WORKSPACE_ID = "workspace_live01_readoption";
/** Frozen before the (simulated) Workspace move. */
const SCOPE_REF = "workspace_frozen_readoption";
const CAPSULE_ID = "cap_scope_readoption";
const CAPSULE_NAME = "scope-app";

const INPUTS: readonly RepositoryInstallUxInput[] = [
  {
    name: "public_url",
    source: { kind: "user" },
    type: "string",
    required: true,
    label: { ja: "公開URL", en: "Public URL" },
  },
  {
    name: "worker_name",
    source: { kind: "workspace_scoped_capsule_name" },
    type: "string",
    required: true,
  },
];

function seedSession(store: InMemoryAccountsStore): string {
  const now = Date.now();
  store.saveAccount({
    subject: SUBJECT,
    email: "scope@example.test",
    displayName: "Scope Re-adoption",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: `sess_${SUBJECT}`,
    subject: SUBJECT,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return `${ACCOUNT_SESSION_COOKIE_NAME}=sess_${SUBJECT}`;
}

const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

function runner(inputs: readonly RepositoryInstallUxInput[]): OpenTofuRunner {
  const variables = inputs
    .map((input) => `variable "${input.name}" {\n  type = string\n}`)
    .join("\n\n");
  return {
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
${variables}

terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

output "launch_url" { value = var.public_url }
`,
        },
      ]),
    plan: () =>
      Promise.resolve({
        planDigest: DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://scope/tfplan",
          digest: DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        planResourceChanges: [],
      }),
  } as unknown as OpenTofuRunner;
}

/** Mirrors the route's generic OpenTofu variable contract digest. */
async function genericVariableContractDigest(
  inputs: readonly RepositoryInstallUxInput[],
  modulePath: string,
): Promise<string> {
  return await stableJsonDigest({
    contract: "takosumi.generic-opentofu-variable-contract/v1",
    modulePath,
    declarations: inputs
      .map((input) => ({
        name: input.name,
        type: input.type ?? "string",
        hasDefault: input.source.kind === "module_default" || input.required === false,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  });
}

/**
 * `re-adoption` adopts a repository profile under a reviewed manifest.
 * `configuration` is a generic-default Capsule with provider connections,
 * the shape a configuration Plan needs.
 */
async function fixture(mode: "re-adoption" | "configuration" = "re-adoption") {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const generic = mode === "configuration";
  const inputs = generic ? INPUTS.slice(0, 1) : INPUTS;
  const modulePath = generic ? "deploy/opentofu/cloudflare" : ".";
  const baseInstallConfig: InstallConfig = generic
    ? defaultCapsuleInstallConfig()
    : {
      id: "cfg_scope_readoption_profile",
      name: "scope-readoption-profile",
      variableMapping: {},
      outputAllowlist: {},
      policy: {
        repositoryInstallUx: { requiredManifestApiVersion: "takosumi.com/v2.2" },
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner(inputs),
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    operatorInstallConfigs: generic ? [] : [baseInstallConfig],
  });
  const snapshotId = "snap_scope_readoption";
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: WORKSPACE_ID,
    sourceId: "src_scope_readoption",
    snapshotId,
    capsuleId: CAPSULE_ID,
    installConfigId: "icfg_scope_readoption_current",
    sourceUrl: "https://git.example.com/takos/scope-readoption.git",
    name: CAPSULE_NAME,
    installConfig: {
      workspaceId: WORKSPACE_ID,
      modulePath,
      internal: generic
        ? {
          reason: "per_install_overrides",
          genericOpenTofuVariableContractDigest: await genericVariableContractDigest(inputs, modulePath),
          genericOpenTofuSourceSnapshotId: snapshotId,
        }
        : { reason: "per_install_overrides", sourceSnapshotId: snapshotId },
      variableMapping: { public_url: "https://scope.example.test" },
    },
  });
  await deployStore.putCapsule({
    ...seeded.capsule,
    installingPrincipalId: SUBJECT,
    status: "active",
    scopeRef: SCOPE_REF,
  });
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [{ path: modulePath, providerPackages: [], rootProviderRequirements: [] }],
    },
    repositoryManifest: generic
      ? { status: "absent" }
      : {
        status: "present",
        digest: `sha256:${"7".repeat(64)}`,
        document: {
          apiVersion: "takosumi.com/v2.2",
          kind: "Repository",
          install: { modules: { ".": { inputs } } },
        },
      },
  });
  if (generic) await seedProviderConnections(deployStore, seeded.capsule);
  return { accountStore, cookie, deployStore, operations, baseInstallConfig, seeded };
}

async function call(
  f: Awaited<ReturnType<typeof fixture>>,
  method: string,
  path: string,
  init: { readonly body?: unknown; readonly headers?: Record<string, string> } = {},
): Promise<{ readonly status: number; readonly json: Record<string, any> }> {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = { cookie: f.cookie, ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await handleControlRoute({
    request: new Request(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    url,
    store: f.accountStore,
    operations: f.operations,
  });
  if (!response) throw new Error(`${method} ${path} was not routed`);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

test("re-adoption derives the successor id and the Workspace-scoped name from the frozen scopeRef", async () => {
  const f = await fixture();
  const stored = await f.operations.capsules.getCapsule(CAPSULE_ID);
  expect(stored.workspaceId).toBe(WORKSPACE_ID);
  expect(stored.scopeRef).toBe(SCOPE_REF);

  const guard = await call(f, "GET", `/api/v1/capsules/${CAPSULE_ID}`);
  expect(guard.status).toBe(200);
  const idempotencyKey = "scope-readoption-v1";
  const adopted = await call(f, "POST", `/api/v1/capsules/${CAPSULE_ID}/install-config-re-adoptions`, {
    headers: { "idempotency-key": idempotencyKey },
    body: {
      baseInstallConfigId: f.baseInstallConfig.id,
      sourceSnapshotId: f.seeded.snapshot.id,
      reason: "Adopt the reviewed repository profile",
      expected: { authorityGuard: guard.json.installConfigReAdoption.authorityGuard },
    },
  });
  expect(adopted.status, JSON.stringify(adopted.json)).toBe(200);

  const ids = async (scopeRef: string) =>
    await reAdoptionTargetInstallConfigId({
      scopeRef,
      capsuleId: CAPSULE_ID,
      actorSubject: SUBJECT,
      idempotencyKeyHash: await stableJsonDigest(idempotencyKey),
    });
  const targetId = adopted.json.installConfigReAdoption.targetInstallConfigId;
  expect(targetId).toBe(await ids(SCOPE_REF));
  expect(targetId).not.toBe(await ids(WORKSPACE_ID));

  const target = await f.operations.capsules.getInstallConfig(targetId);
  // `workspace_scoped_capsule_name` becomes a cloud resource name: it follows
  // the frozen scope, so Workspace removal never renames (recreates) it.
  expect(target.variableMapping.worker_name).toBe(
    `${CAPSULE_NAME}-${workspaceSlugSuffix(SCOPE_REF)}`,
  );
  expect(workspaceSlugSuffix(SCOPE_REF)).not.toBe(workspaceSlugSuffix(WORKSPACE_ID));
  // The successor stays in the Capsule's authority Workspace.
  expect(target.workspaceId).toBe(WORKSPACE_ID);
});

test("a configuration Plan derives its successor id from the frozen scopeRef", async () => {
  const f = await fixture("configuration");
  expect((await f.operations.capsules.getCapsule(CAPSULE_ID)).scopeRef).toBe(SCOPE_REF);
  const bindingSet = await f.operations.capsules.getProviderBindingSetByCapsule(
    CAPSULE_ID,
    f.seeded.capsule.environment,
  );
  if (!bindingSet) throw new Error("fixture ProviderBindingSet is missing");
  const guard = await call(f, "GET", `/api/v1/capsules/${CAPSULE_ID}`);
  expect(guard.status).toBe(200);
  const idempotencyKey = "scope-configuration-v1";
  const planned = await call(f, "POST", `/api/v1/capsules/${CAPSULE_ID}/configuration-plans`, {
    headers: { "idempotency-key": idempotencyKey },
    body: {
      variablePatch: { set: { public_url: "https://configured.example.test" }, remove: [] },
      providerBindings: bindingSet.bindings,
      interfaceBlueprints: [],
      expected: { authorityGuard: guard.json.installConfigReAdoption.authorityGuard },
    },
  });
  expect(planned.status, JSON.stringify(planned.json)).toBe(201);

  const ids = async (scopeRef: string) =>
    await configurationTargetInstallConfigId({
      scopeRef,
      capsuleId: CAPSULE_ID,
      actorSubject: SUBJECT,
      idempotencyKeyHash: await stableJsonDigest(idempotencyKey),
    });
  const targetId = planned.json.configurationPlan.targetInstallConfigId;
  // A retry after Workspace removal must find this same successor.
  expect(targetId).toBe(await ids(SCOPE_REF));
  expect(targetId).not.toBe(await ids(WORKSPACE_ID));
  expect((await f.operations.capsules.getInstallConfig(targetId)).workspaceId).toBe(WORKSPACE_ID);
});
