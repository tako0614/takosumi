import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UI_SURFACE_OPEN_PERMISSION,
  isBundledResourceShapeKind,
  parseRepositoryInstallUxText,
  type CapsuleCompatibilityReport,
} from "takosumi-contract";
import { resolveCapsuleResourceInterfaceBindingInstallingPrincipal } from "takosumi-contract/interfaces";
import { compileRepositoryInstallUx } from "../../../core/domains/capsules/repository_install_ux_compiler.ts";
import { createD1FormRegistryStore } from "../../../core/domains/service-forms/d1_store.ts";
import { createD1InterfaceStores } from "../../../core/domains/interfaces/d1_stores.ts";
import { createD1ResourceShapeStores } from "../../../core/domains/resource-shape/d1_stores.ts";
import { MapResourceShapeSchemaRegistry } from "../../../core/domains/resource-shape/planner.ts";
import { PORTABLE_FORM_MANAGER } from "../../../core/api/form_host_routes.ts";
import { createManagedProviderRunToken } from "../../../core/shared/managed_provider_tokens.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../../deploy/reference-app-install-configs.ts";
import worker from "../../../deploy/platform/worker.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const ROOT = new URL("../../../../", import.meta.url);
const YURUCOMMU_ROOT = new URL("yurucommu/", ROOT);
const TAKOFORM_ROOT = new URL("takoform/", ROOT);
const EXACT_TOFU = "/root/.local/libexec/opentofu-1.12.1/tofu";
const PROVIDER_ADDRESS = "registry.opentofu.org/tako0614/takoform";
const WORKSPACE_ID = "workspace_yurucommu_real_lifecycle";
const CAPSULE_ID = "capsule_yurucommu_real_lifecycle";
const INSTALL_CONFIG_ID = "icfg_yurucommu_real_lifecycle";
const INSTALLER_ID = "principal_yurucommu_real_lifecycle";
const PROJECT_NAME = "e2e-yuru";
const NOW = "2026-07-29T00:00:00.000Z";
const HOST_TOKEN_SECRET = "managed-provider-real-lifecycle-secret";
const TARGET_CLASS = "test.yurucommu.managed";

interface StandardFormPackage {
  readonly kind: string;
  readonly path: string;
  readonly formRef: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  };
  readonly packageDigest: string;
}

interface StandardPackageSet {
  readonly packages: readonly StandardFormPackage[];
}

interface PluginCall {
  readonly action: string;
  readonly input: Record<string, unknown>;
  readonly resource?: {
    readonly kind?: string;
    readonly spec?: Record<string, unknown>;
  };
}

test("repository install executes exact OpenTofu/Takoform apply and destroy against the production Form host", async () => {
  const temp = await mkdtemp(join(tmpdir(), "takosumi-yurucommu-e2e-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const providerVersion = (
      JSON.parse(
        await readFile(new URL("release/version.json", TAKOFORM_ROOT), "utf8"),
      ) as { readonly version: string }
    ).version;
    expect(providerVersion).toBe("0.2.1");
    const providerBinDir = join(temp, "provider-bin");
    await mkdir(providerBinDir, { recursive: true });
    const providerBinary = join(providerBinDir, "terraform-provider-takoform");
    await run(
      [
        "go",
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags",
        `-buildid= -X main.version=${providerVersion}`,
        "-o",
        providerBinary,
        ".",
      ],
      { cwd: TAKOFORM_ROOT.pathname },
    );

    const moduleDir = join(temp, "module");
    await cp(new URL("deploy/takoform/", YURUCOMMU_ROOT), moduleDir, {
      recursive: true,
    });
    const cliConfig = join(temp, "tofurc");
    await writeFile(
      cliConfig,
      `provider_installation {
  dev_overrides {
    "${PROVIDER_ADDRESS}" = "${providerBinDir}"
  }
  direct {}
}
`,
      { mode: 0o600 },
    );

    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    const control = new CloudflareD1OpenTofuControlStore(db);
    await control.putWorkspace({
      id: WORKSPACE_ID,
      handle: "yurucommu-real-lifecycle",
      displayName: "Yurucommu real lifecycle",
      type: "personal",
      ownerUserId: INSTALLER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const manifestText = await readFile(
      new URL(".well-known/takosumi.json", YURUCOMMU_ROOT),
      "utf8",
    );
    const manifest = parseRepositoryInstallUxText(manifestText);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) throw new Error(manifest.error);
    const baseConfig = REFERENCE_APP_INSTALL_CONFIGS.find(
      (config) =>
        config.sourceSelector?.url ===
          "https://github.com/tako0614/yurucommu.git" &&
        config.modulePath === "deploy/takoform",
    );
    expect(baseConfig).toBeDefined();
    if (!baseConfig) throw new Error("managed Yurucommu config missing");
    const compatibility = yurucommuCompatibilityReport();
    const compiled = compileRepositoryInstallUx({
      document: manifest.document,
      sourceSnapshotId: compatibility.sourceSnapshotId,
      modulePath: "deploy/takoform",
      compatibilityReport: compatibility,
      capsuleName: PROJECT_NAME,
      workspaceId: WORKSPACE_ID,
      reviewedVariables: {},
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.diagnostic.message);
    expect(compiled.compiled.variableMapping).toEqual({
      project_name: PROJECT_NAME,
    });

    await control.putInstallConfig({
      ...baseConfig,
      id: INSTALL_CONFIG_ID,
      workspaceId: WORKSPACE_ID,
      name: `${PROJECT_NAME}-repository-install`,
      internal: {
        reason: "per_install_overrides",
        sourceSnapshotId: compatibility.sourceSnapshotId,
      },
      variableMapping: compiled.compiled.variableMapping,
      variablePresentation: compiled.compiled.variablePresentation,
      userVariableNames: compiled.compiled.userVariableNames,
      installExperience: compiled.compiled.installExperience,
      resourceInterfaceBindingProposals:
        resolveCapsuleResourceInterfaceBindingInstallingPrincipal(
          baseConfig.resourceInterfaceBindingProposals,
          INSTALLER_ID,
        ),
      updatedAt: NOW,
    });
    await control.putCapsule({
      id: CAPSULE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: "project_yurucommu_real_lifecycle",
      name: PROJECT_NAME,
      slug: PROJECT_NAME,
      sourceId: "source_yurucommu_real_lifecycle",
      installConfigId: INSTALL_CONFIG_ID,
      installingPrincipalId: INSTALLER_ID,
      environment: "production",
      currentStateGeneration: 0,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const scopedInstallConfig =
      await control.getInstallConfig(INSTALL_CONFIG_ID);
    expect(scopedInstallConfig?.lifecycleActions).toEqual(
      baseConfig.lifecycleActions,
    );

    const packageSet = JSON.parse(
      await readFile(
        new URL("forms/standard-package-set.json", TAKOFORM_ROOT),
        "utf8",
      ),
    ) as StandardPackageSet;
    const desiredKinds = new Set([
      "RelationalDatabase",
      "ObjectBucket",
      "KeyValueStore",
      "Queue",
      "HttpService",
      "Schedule",
    ]);
    const packages = packageSet.packages.filter((item) =>
      desiredKinds.has(item.kind),
    );
    expect(packages.map((item) => item.kind).sort()).toEqual(
      [...desiredKinds].sort(),
    );
    const registry = createD1FormRegistryStore(db);
    for (const item of packages) {
      await registry.installPackage(
        {
          packageDigest: item.packageDigest,
          artifactRef: `file://${TAKOFORM_ROOT.pathname}${item.path}`,
          verifierId: "local-reviewed-takoform-package-set",
          status: "installed",
          definitionRefs: [
            {
              type: internalFormType(item.formRef.kind),
              version: item.formRef.definitionVersion,
              schemaDigest: item.formRef.schemaDigest,
            },
          ],
          installedAt: NOW,
          installedBy: "local-e2e",
          updatedAt: NOW,
        },
        [
          {
            identity: {
              type: internalFormType(item.formRef.kind),
              version: item.formRef.definitionVersion,
              schemaDigest: item.formRef.schemaDigest,
              packageDigest: item.packageDigest,
            },
            displayName: item.formRef.kind,
            operations: ["create", "read", "update", "delete"],
            installedAt: NOW,
          },
        ],
      );
      await registry.createActivation({
        id: `activation_yurucommu_${item.kind}`,
        identity: {
          type: internalFormType(item.formRef.kind),
          version: item.formRef.definitionVersion,
          schemaDigest: item.formRef.schemaDigest,
          packageDigest: item.packageDigest,
        },
        scope: { type: "space", id: WORKSPACE_ID },
        audience: { public: true },
        policy: {},
        eligibleTargetPoolClasses: [TARGET_CLASS],
        status: "active",
        revision: 1,
        createdAt: NOW,
        createdBy: "local-e2e",
        updatedAt: NOW,
        updatedBy: "local-e2e",
      });
    }

    const resourceStores = createD1ResourceShapeStores(db);
    await resourceStores.targetPools.upsert({
      id: `tkrn:${WORKSPACE_ID}:TargetPool:default`,
      spaceId: WORKSPACE_ID,
      name: "default",
      spec: {
        classes: [TARGET_CLASS],
        targets: [
          {
            name: "local-managed",
            type: "managed",
            priority: 100,
            implementations: packages.map((item) => ({
              shape: item.kind,
              implementation: `local.${item.kind}`,
              interfaces: implementationInterfaces(item.kind),
              plugin: "local-yurucommu-managed",
            })),
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

    const pluginCalls: PluginCall[] = [];
    const schemaRegistry = new MapResourceShapeSchemaRegistry(
      Object.fromEntries(
        [...desiredKinds]
          .filter((kind) => !isBundledResourceShapeKind(kind))
          .map((kind) => [
            kind,
            (raw: unknown) => {
              if (
                typeof raw !== "object" ||
                raw === null ||
                Array.isArray(raw) ||
                typeof (raw as Record<string, unknown>).name !== "string"
              ) {
                return {
                  ok: false as const,
                  error: {
                    code: "invalid_name",
                    message: `${kind} name is required`,
                  },
                };
              }
              return {
                ok: true as const,
                value: {
                  spec: structuredClone(raw) as Record<string, never>,
                  interfaces: [],
                },
              };
            },
          ]),
      ),
    );
    const plugin = {
      fetch: async (request: Request) => {
        const call = (await request.json()) as PluginCall;
        pluginCalls.push(structuredClone(call));
        const resourceId =
          typeof call.input.resourceId === "string"
            ? call.input.resourceId
            : "";
        const identity = resourceIdentity(call.resource, resourceId);
        const nativeResources = [
          {
            type: `local.${identity.kind}`,
            id: identity.name,
            ownership: "resource",
          },
        ];
        if (call.action === "preview") {
          return Response.json({
            summary: `preview ${identity.kind}/${identity.name}`,
            nativeResources,
          });
        }
        if (call.action === "apply" || call.action === "refresh") {
          return Response.json({
            ...(call.action === "refresh"
              ? { summary: `refresh ${identity.kind}/${identity.name}` }
              : {}),
            outputs: resourceOutputs(identity.kind, identity.name),
            nativeResources,
          });
        }
        if (call.action === "observe") {
          return Response.json({
            status: "current",
            summary: `current ${identity.kind}/${identity.name}`,
          });
        }
        if (call.action === "delete") {
          return new Response(null, { status: 204 });
        }
        return Response.json(
          { error: "unexpected_plugin_action" },
          {
            status: 400,
          },
        );
      },
    };
    const env = {
      TAKOSUMI_CONTROL_DB: db,
      TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.e2e.test",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
      TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: HOST_TOKEN_SECRET,
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_RESOURCE_SHAPES: [...desiredKinds].join(","),
      TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY: schemaRegistry,
      TAKOSUMI_RESOURCE_ADAPTER_PLUGIN_HANDLERS: JSON.stringify([
        {
          plugin: "local-yurucommu-managed",
          handlerKey: "LOCAL_YURUCOMMU_MANAGED",
        },
      ]),
      LOCAL_YURUCOMMU_MANAGED: plugin,
    } as never;

    server = Bun.serve({
      port: 0,
      fetch: (request) => worker.fetch(request, env),
    });
    const endpoint = new URL(server.url);
    endpoint.hostname = "127.0.0.1";

    const applyToken = await createManagedProviderRunToken({
      secret: HOST_TOKEN_SECRET,
      audience: PORTABLE_FORM_MANAGER,
      workspaceId: WORKSPACE_ID,
      capsuleId: CAPSULE_ID,
      runId: "run_yurucommu_real_apply",
      installingPrincipalId: INSTALLER_ID,
      connectionId: "connection_takoform_local_e2e",
      provider: PROVIDER_ADDRESS,
      phase: "apply",
      scopes: ["read", "write", "interfaces:write"],
    });
    const tofuEnv = {
      ...process.env,
      TF_CLI_CONFIG_FILE: cliConfig,
      TF_IN_AUTOMATION: "1",
      CHECKPOINT_DISABLE: "1",
      TAKOFORM_ENDPOINT: endpoint.origin,
      TAKOFORM_SPACE: WORKSPACE_ID,
      TAKOFORM_TOKEN: applyToken.token,
    };
    const plan = await run(
      [
        EXACT_TOFU,
        `-chdir=${moduleDir}`,
        "plan",
        "-input=false",
        "-no-color",
        "-out=tfplan",
        `-var=project_name=${PROJECT_NAME}`,
      ],
      { env: tofuEnv },
    );
    expect(plan).toContain("Plan: 8 to add, 0 to change, 0 to destroy.");
    await run(
      [
        EXACT_TOFU,
        `-chdir=${moduleDir}`,
        "apply",
        "-input=false",
        "-no-color",
        "-auto-approve",
        "tfplan",
      ],
      { env: tofuEnv },
    );

    const resources = await resourceStores.resources.listBySpace(WORKSPACE_ID);
    expect(resources).toHaveLength(7);
    expect(resources.map((resource) => resource.kind).sort()).toEqual(
      [
        "HttpService",
        "KeyValueStore",
        "ObjectBucket",
        "Queue",
        "Queue",
        "RelationalDatabase",
        "Schedule",
      ].sort(),
    );
    for (const resource of resources) {
      expect(resource.owner).toEqual({
        kind: "Capsule",
        id: CAPSULE_ID,
        workspaceId: WORKSPACE_ID,
        installingPrincipalId: INSTALLER_ID,
      });
      expect(resource.phase).toBe("Ready");
    }
    const httpApply = pluginCalls.find(
      (call) =>
        call.action === "apply" && call.resource?.kind === "HttpService",
    );
    expect(httpApply?.input.hostRuntimeMaterialization).toMatchObject({
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: INSTALL_CONFIG_ID,
      workspaceId: WORKSPACE_ID,
      capsuleId: CAPSULE_ID,
      installingPrincipalId: INSTALLER_ID,
      requirements: baseConfig.hostRuntimeMaterialization?.requirements,
      backgroundActivations:
        baseConfig.hostRuntimeMaterialization?.backgroundActivations,
    });

    const interfaceStores = createD1InterfaceStores(db);
    const httpResource = resources.find(
      (resource) => resource.kind === "HttpService",
    )!;
    const interfaces = await interfaceStores.interfaces.list({
      workspaceId: WORKSPACE_ID,
      ownerKind: "Resource",
      ownerId: httpResource.id,
      includeRetired: false,
    });
    expect(interfaces).toHaveLength(1);
    expect(interfaces[0]).toMatchObject({
      metadata: {
        materializedFrom: {
          source: "portable_iac",
          descriptorName: "yurucommu.launcher",
          descriptorVersion: "1",
        },
      },
      spec: {
        type: "yurucommu.launcher",
        version: "1",
        document: {
          launcher: true,
          endpoint: { originInput: "origin", path: "/" },
        },
      },
      status: {
        phase: "Resolved",
        resolvedInputs: {
          origin: `https://${PROJECT_NAME}.apps.e2e.test`,
        },
      },
    });
    const bindings = await interfaceStores.bindings.listByInterface(
      interfaces[0]!.metadata.id,
    );
    expect(bindings).toMatchObject([
      {
        spec: {
          subjectRef: { kind: "Principal", id: INSTALLER_ID },
          permissions: [UI_SURFACE_OPEN_PERMISSION],
        },
        status: { phase: "Ready" },
      },
    ]);

    const destroyToken = await createManagedProviderRunToken({
      secret: HOST_TOKEN_SECRET,
      audience: PORTABLE_FORM_MANAGER,
      workspaceId: WORKSPACE_ID,
      capsuleId: CAPSULE_ID,
      runId: "run_yurucommu_real_destroy",
      installingPrincipalId: INSTALLER_ID,
      connectionId: "connection_takoform_local_e2e",
      provider: PROVIDER_ADDRESS,
      phase: "destroy",
      scopes: ["read", "write", "interfaces:write"],
    });
    await run(
      [
        EXACT_TOFU,
        `-chdir=${moduleDir}`,
        "destroy",
        "-input=false",
        "-no-color",
        "-auto-approve",
        `-var=project_name=${PROJECT_NAME}`,
      ],
      {
        env: { ...tofuEnv, TAKOFORM_TOKEN: destroyToken.token },
      },
    );
    expect(await resourceStores.resources.listBySpace(WORKSPACE_ID)).toEqual(
      [],
    );
    const retiredInterfaces = await interfaceStores.interfaces.list({
      workspaceId: WORKSPACE_ID,
      ownerKind: "Resource",
      ownerId: httpResource.id,
      includeRetired: true,
    });
    expect(retiredInterfaces).toHaveLength(1);
    expect(retiredInterfaces[0]?.status.phase).toBe("Retired");
    expect(
      (
        await interfaceStores.bindings.listByInterface(
          retiredInterfaces[0]!.metadata.id,
        )
      )[0]?.status.phase,
    ).toBe("Revoked");
  } finally {
    server?.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
}, 180_000);

function yurucommuCompatibilityReport(): CapsuleCompatibilityReport {
  const variables = [
    "project_name",
    "worker_release_tag",
    "worker_bundle_url",
    "worker_bundle_sha256",
  ];
  return {
    id: "compat_yurucommu_real_lifecycle",
    sourceId: "source_yurucommu_real_lifecycle",
    sourceSnapshotId: "snapshot_yurucommu_real_lifecycle",
    modulePath: "deploy/takoform",
    level: "ready",
    findings: [],
    providers: [PROVIDER_ADDRESS],
    resources: [
      "takoform_http_service.worker",
      "takoform_relational_database.database",
      "takoform_object_bucket.media",
      "takoform_key_value_store.kv",
      "takoform_queue.delivery",
      "takoform_queue.delivery_dlq",
      "takoform_schedule.retention",
      "takoform_interface.launcher",
    ],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: variables,
    rootModuleVariableDeclarations: variables.map((name) => ({
      name,
      type: "string",
      hasDefault: true,
    })),
    rootModuleOutputs: [
      "worker_name",
      "launch_url",
      "api_url",
      "takoform_resource_ids",
    ],
    createdAt: NOW,
  };
}

function resourceIdentity(
  resource: PluginCall["resource"],
  resourceId: string,
): { readonly kind: string; readonly name: string } {
  const segments = resourceId.split(":");
  const kind =
    resource?.kind ??
    (segments.length >= 4 ? segments[segments.length - 2] : undefined);
  const name =
    (typeof resource?.spec?.name === "string"
      ? resource.spec.name
      : undefined) ?? segments.at(-1);
  if (!kind || !name) throw new Error("plugin resource identity missing");
  return { kind, name };
}

function resourceOutputs(kind: string, name: string): Record<string, unknown> {
  if (kind === "HttpService") {
    return {
      name,
      url: `https://${name}.apps.e2e.test`,
      nativeId: `worker-${name}`,
    };
  }
  return { name, nativeId: `${kind.toLowerCase()}-${name}` };
}

function internalFormType(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function implementationInterfaces(
  kind: string,
): Readonly<Record<string, "native">> {
  switch (kind) {
    case "ObjectBucket":
      return { object_store: "native", s3_api: "native" };
    case "Queue":
      return { queue: "native", publish: "native", consume: "native" };
    case "Schedule":
      return {
        schedule: "native",
        cron: "native",
        invoke: "native",
        resource_connection: "native",
        "schedule.trigger.v1": "native",
        grant_invoke: "native",
      };
    default:
      return {};
  }
}

async function run(
  command: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<string> {
  const child = Bun.spawn([...command], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`,
    );
  }
  return `${stdout}\n${stderr}`;
}
