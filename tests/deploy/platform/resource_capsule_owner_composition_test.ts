import { expect, test } from "bun:test";
import {
  TAKOFORM_FORM_HOST_API_PATH,
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";
import worker from "../../../deploy/platform/worker.ts";
import { PORTABLE_FORM_MANAGER } from "../../../core/api/form_host_routes.ts";
import { createManagedProviderRunToken } from "../../../core/shared/managed_provider_tokens.ts";
import { createD1ResourceShapeStores } from "../../../core/domains/resource-shape/d1_stores.ts";
import { createD1FormRegistryStore } from "../../../core/domains/service-forms/d1_store.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-07-29T00:00:00.000Z";
const WORKSPACE_ID = "workspace_capsule_owner";
const CAPSULE_ID = "capsule_owner_composition";
const INSTALLER_ID = "principal_capsule_installer";
const FORM = {
  type: "object_bucket",
  version: "1.0.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
  packageDigest: `sha256:${"2".repeat(64)}`,
} as const;

test("production platform keeps the portable Form host absent without durable idempotency authority", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db);
  await control.putWorkspace({
    id: WORKSPACE_ID,
    handle: "capsule-owner",
    displayName: "Capsule owner",
    type: "personal",
    ownerUserId: INSTALLER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await control.putInstallConfig({
    id: "config_capsule_owner",
    workspaceId: WORKSPACE_ID,
    name: "capsule-owner-config",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    resourceInterfaceBindingProposals: [
      {
        key: "installed-app-launcher",
        interface: {
          name: UI_SURFACE_INTERFACE_TYPE,
          version: UI_SURFACE_INTERFACE_VERSION,
          resourceKind: "ObjectBucket",
          resourceName: "assets",
        },
        subjectRef: { kind: "Principal", id: INSTALLER_ID },
        permissions: [UI_SURFACE_OPEN_PERMISSION],
        delivery: { type: "none" },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await control.putCapsule({
    id: CAPSULE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: "project_capsule_owner",
    name: "capsule-owner",
    slug: "capsule-owner",
    sourceId: "source_capsule_owner",
    installConfigId: "config_capsule_owner",
    installingPrincipalId: INSTALLER_ID,
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });

  const formRegistry = createD1FormRegistryStore(db);
  await formRegistry.installPackage(
    {
      packageDigest: FORM.packageDigest,
      artifactRef: "oci://forms.example/object-bucket@sha256:owner",
      verifierId: "test-verifier",
      status: "installed",
      definitionRefs: [
        {
          type: FORM.type,
          version: FORM.version,
          schemaDigest: FORM.schemaDigest,
        },
      ],
      installedAt: NOW,
      installedBy: "test",
      updatedAt: NOW,
    },
    [
      {
        identity: FORM,
        displayName: "Object bucket",
        operations: ["create", "read", "update", "delete"],
        installedAt: NOW,
      },
    ],
  );
  await formRegistry.createActivation({
    id: "activation_capsule_owner",
    identity: FORM,
    scope: { type: "space", id: WORKSPACE_ID },
    audience: { public: true },
    policy: {},
    eligibleTargetPoolClasses: ["edge.object-store"],
    status: "active",
    revision: 1,
    createdAt: NOW,
    createdBy: "test",
    updatedAt: NOW,
    updatedBy: "test",
  });

  const resourceStores = createD1ResourceShapeStores(db);
  await resourceStores.targetPools.upsert({
    id: `tkrn:${WORKSPACE_ID}:TargetPool:default`,
    spaceId: WORKSPACE_ID,
    name: "default",
    spec: {
      classes: ["edge.object-store"],
      targets: [
        {
          name: "managed",
          type: "managed",
          priority: 100,
          implementations: [
            {
              shape: "ObjectBucket",
              implementation: "test.managed-bucket",
              interfaces: { object_store: "native", s3_api: "native" },
              plugin: "test-managed-bucket",
            },
          ],
        },
      ],
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await resourceStores.spacePolicies.upsert({
    id: `tkrn:${WORKSPACE_ID}:SpacePolicy:default`,
    spaceId: WORKSPACE_ID,
    name: "default",
    spec: {
      resolution: { lockAfterCreate: true, allowAutoMigration: false },
    },
    createdAt: NOW,
    updatedAt: NOW,
  });

  const pluginInputs: unknown[] = [];
  const env = {
    TAKOSUMI_CONTROL_DB: db,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
    TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-provider-secret",
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
    TAKOSUMI_RESOURCE_ADAPTER_PLUGIN_HANDLERS: JSON.stringify([
      {
        plugin: "test-managed-bucket",
        handlerKey: "TEST_MANAGED_BUCKET",
      },
    ]),
    TEST_MANAGED_BUCKET: {
      fetch: async (request: Request) => {
        const body = (await request.json()) as {
          readonly action: string;
          readonly input: unknown;
        };
        pluginInputs.push(body.input);
        return body.action === "preview"
          ? Response.json({
              summary: "create managed bucket",
              nativeResources: [
                { type: "managed.object_bucket", id: "assets" },
              ],
            })
          : Response.json({
              outputs: { bucket_name: "assets" },
              nativeResources: [
                { type: "managed.object_bucket", id: "assets" },
              ],
            });
      },
    },
  } as never;
  const issued = await createManagedProviderRunToken({
    secret: "managed-provider-secret",
    audience: PORTABLE_FORM_MANAGER,
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    runId: "run_capsule_owner_apply",
    installingPrincipalId: INSTALLER_ID,
    connectionId: "connection_takoform",
    provider: "registry.opentofu.org/takoform/takoform",
    phase: "apply",
    scopes: ["write", "interfaces:write"],
  });
  const authorization = `Bearer ${issued.token}`;
  const desired = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    form: {
      formRef: {
        apiVersion: "forms.takoform.com/v1alpha1",
        kind: "ObjectBucket",
        definitionVersion: FORM.version,
        schemaDigest: FORM.schemaDigest,
      },
      packageDigest: FORM.packageDigest,
    },
    metadata: { space: WORKSPACE_ID, name: "assets" },
    spec: { name: "assets" },
  };
  const preview = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/resources/preview`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "if-none-match": "*",
        },
        body: JSON.stringify(desired),
      },
    ),
    env,
  );
  expect(preview.status).toBe(404);
  const discovery = await worker.fetch(
    new Request(
      "https://app.takosumi.test/.well-known/takoform",
      { headers: { authorization } },
    ),
    env,
  );
  expect(discovery.status).toBe(404);
  expect(
    await resourceStores.resources.get(
      `tkrn:${WORKSPACE_ID}:ObjectBucket:assets`,
    ),
  ).toBeUndefined();
  expect(pluginInputs).toEqual([]);
});

test("production platform rejects an incomplete managed token before route resolution", async () => {
  const issued = await createManagedProviderRunToken({
    secret: "managed-provider-secret",
    audience: PORTABLE_FORM_MANAGER,
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    connectionId: "connection_takoform",
    provider: "registry.opentofu.org/takoform/takoform",
    phase: "apply",
    scopes: ["write"],
  });
  const response = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/forms?space=${WORKSPACE_ID}`,
      { headers: { authorization: `Bearer ${issued.token}` } },
    ),
    {
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
      TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-provider-secret",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
    } as never,
  );
  expect(response.status).toBe(401);
});
