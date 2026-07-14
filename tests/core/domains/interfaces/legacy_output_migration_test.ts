import { expect, test } from "bun:test";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
  OutputBackedInterfaceInputResolver,
} from "../../../../core/domains/interfaces/mod.ts";
import {
  LegacyOutputInterfaceMigrationError,
  LegacyOutputInterfaceMigrationService,
} from "../../../../core/domains/interfaces/legacy_output_migration.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = "2026-07-14T12:00:00.000Z";
const OUTPUT_DIGEST = `sha256:${"a".repeat(64)}`;

async function fixture(options: { readonly blueprints?: boolean } = {}) {
  const opentofu = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(opentofu, {
    workspaceId: "workspace_migration",
    capsuleId: "cap_legacy",
    installConfig: options.blueprints
      ? {
          interfaceBlueprints: [
            {
              key: "main-mcp",
              name: "main-mcp",
              spec: {
                type: "mcp.server",
                version: "2025-11-25",
                document: { transport: "streamable-http" },
                inputs: {
                  endpoint: {
                    source: "capsule_output",
                    outputName: "launch_url",
                  },
                },
                access: {
                  visibility: "private",
                  resourceUriInput: "endpoint",
                },
              },
            },
          ],
        }
      : undefined,
  });
  await opentofu.putOutput({
    id: "out_legacy",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "sealed/out_legacy",
    publicOutputs: {
      launch_url: "https://legacy.example.test/mcp",
      app_deployment: { url: "https://legacy.example.test/mcp" },
    },
    workspaceOutputs: {
      launch_url: "https://legacy.example.test/mcp",
      app_deployment: { url: "https://legacy.example.test/mcp" },
      admin_token: "must-never-be-reported",
    },
    outputDigest: OUTPUT_DIGEST,
    createdAt: NOW,
  });
  await opentofu.putStateVersion({
    id: "state_legacy",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: "sealed/state_legacy",
    digest: `sha256:${"b".repeat(64)}`,
    createdByRunId: "run_apply_legacy",
    createdAt: NOW,
  });
  await opentofu.patchCapsule(seeded.capsule.id, {
    currentOutputId: "out_legacy",
    currentStateVersionId: "state_legacy",
    currentStateGeneration: 1,
    status: "active",
    updatedAt: NOW,
  });
  let id = 0;
  const interfaces = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: new OutputBackedInterfaceInputResolver({ opentofu }),
    now: () => NOW,
    newId: (prefix) => `${prefix}_migration_${++id}`,
  });
  const migration = new LegacyOutputInterfaceMigrationService({
    opentofu,
    interfaces,
    now: () => NOW,
  });
  return { opentofu, seeded, interfaces, migration };
}

test("report returns names and digests only and never reports secret-shaped Output names", async () => {
  const { migration } = await fixture();

  const report = await migration.report("workspace_migration");

  expect(report.issues).toEqual([]);
  expect(report.candidates).toHaveLength(1);
  expect(report.candidates[0]).toMatchObject({
    capsuleId: "cap_legacy",
    outputId: "out_legacy",
    outputDigest: OUTPUT_DIGEST,
    mode: "owner_selection_required",
    legacyConventionNames: ["app_deployment"],
    availableOutputNames: ["app_deployment", "launch_url"],
  });
  expect(JSON.stringify(report)).not.toContain("must-never-be-reported");
  expect(JSON.stringify(report)).not.toContain("admin_token");
});

test("manual confirmation creates one explicit Output mapping and durable idempotent evidence", async () => {
  const { migration, interfaces, opentofu } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  expect(candidate).toBeDefined();
  const input = {
    ...candidate!,
    confirmedBy: "operator_1",
    selection: {
      name: "main-mcp",
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputName: "endpoint",
      outputName: "launch_url",
      access: {
        visibility: "private" as const,
        resourceUriInput: "endpoint",
      },
    },
  };

  const first = await migration.confirm(input);
  const second = await migration.confirm(input);

  expect(second).toEqual(first);
  const records = await interfaces.list({
    workspaceId: "workspace_migration",
    ownerKind: "Capsule",
    ownerId: "cap_legacy",
    includeRetired: true,
  });
  expect(records).toHaveLength(1);
  expect(records[0]?.status.phase).toBe("Resolved");
  expect(records[0]?.spec.inputs).toEqual({
    endpoint: {
      source: "capsule_output",
      capsuleId: "cap_legacy",
      outputName: "launch_url",
    },
  });
  const evidence = (
    await opentofu.listActivityEvents("workspace_migration")
  ).filter((event) => event.id === first.evidenceEventId);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    actorId: "operator_1",
    action: "interface.output_convention_migrated",
    targetType: "capsule",
    targetId: "cap_legacy",
    metadata: {
      outputId: "out_legacy",
      outputDigest: OUTPUT_DIGEST,
      mode: "owner_selection_required",
      interfaceIds: first.interfaceIds,
    },
  });
  expect(JSON.stringify(evidence)).not.toContain("legacy.example.test");
  expect(JSON.stringify(evidence)).not.toContain("must-never-be-reported");
  expect((await migration.report("workspace_migration")).completed).toEqual([
    {
      capsuleId: "cap_legacy",
      evidenceEventId: first.evidenceEventId,
      interfaceIds: first.interfaceIds,
    },
  ]);
});

test("evidence write failure retries without duplicating the materialized Interface", async () => {
  const { migration, interfaces, opentofu } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  const input = {
    ...candidate!,
    confirmedBy: "operator_1",
    selection: {
      name: "main-mcp",
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputName: "endpoint",
      outputName: "launch_url",
      access: { visibility: "private" as const },
    },
  };
  const putEvidence = opentofu.putActivityEvent.bind(opentofu);
  let failEvidence = true;
  opentofu.putActivityEvent = async (event) => {
    if (failEvidence) throw new Error("simulated audit outage");
    return await putEvidence(event);
  };

  await expect(migration.confirm(input)).rejects.toThrow(
    "simulated audit outage",
  );
  expect(
    await interfaces.list({
      workspaceId: "workspace_migration",
      ownerKind: "Capsule",
      ownerId: "cap_legacy",
      includeRetired: true,
    }),
  ).toHaveLength(1);

  failEvidence = false;
  const recovered = await migration.confirm(input);
  expect(recovered.interfaceIds).toHaveLength(1);
  expect(
    (await opentofu.listActivityEvents("workspace_migration")).filter(
      (event) => event.id === recovered.evidenceEventId,
    ),
  ).toHaveLength(1);
});

test("completion evidence is fenced to the exact current Output candidate", async () => {
  const { migration, opentofu } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  await migration.confirm({
    ...candidate!,
    confirmedBy: "operator_1",
    selection: {
      name: "main-mcp",
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputName: "endpoint",
      outputName: "launch_url",
      access: { visibility: "private" },
    },
  });

  await opentofu.putOutput({
    id: "out_changed",
    workspaceId: "workspace_migration",
    capsuleId: "cap_legacy",
    stateGeneration: 2,
    rawArtifactRef: "sealed/out_changed",
    publicOutputs: {
      launch_url: "https://changed.example.test/mcp",
      app_deployment: { url: "https://changed.example.test/mcp" },
    },
    workspaceOutputs: {
      launch_url: "https://changed.example.test/mcp",
      app_deployment: { url: "https://changed.example.test/mcp" },
    },
    outputDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-07-14T12:01:00.000Z",
  });
  await opentofu.patchCapsule("cap_legacy", {
    currentOutputId: "out_changed",
    currentStateGeneration: 2,
    updatedAt: "2026-07-14T12:01:00.000Z",
  });

  const report = await migration.report("workspace_migration");
  expect(report.candidates[0]?.outputId).toBe("out_changed");
  expect(report.completed).toEqual([]);
});

test("completion evidence is fenced to the reviewed InstallConfig revision", async () => {
  const { migration, opentofu, seeded } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  await migration.confirm({
    ...candidate!,
    confirmedBy: "operator_1",
    selection: {
      name: "main-mcp",
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputName: "endpoint",
      outputName: "launch_url",
      access: { visibility: "private" },
    },
  });

  await opentofu.putInstallConfig({
    ...seeded.installConfig,
    updatedAt: "2026-07-14T12:01:00.000Z",
  });

  const report = await migration.report("workspace_migration");
  expect(report.candidates[0]?.installConfigUpdatedAt).toBe(
    "2026-07-14T12:01:00.000Z",
  );
  expect(report.completed).toEqual([]);
});

test("known service-side blueprints are the authority and owner selection is rejected", async () => {
  const { migration, interfaces } = await fixture({ blueprints: true });
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  expect(candidate?.mode).toBe("service_blueprints");
  expect(candidate?.interfaceBlueprintsDigest).toStartWith("sha256:");

  const result = await migration.confirm({
    ...candidate!,
    confirmedBy: "operator_1",
  });
  expect(result.interfaceIds).toHaveLength(1);
  const [record] = await interfaces.list({
    workspaceId: "workspace_migration",
    ownerKind: "Capsule",
    ownerId: "cap_legacy",
    includeRetired: true,
  });
  expect(record?.metadata.materializedFrom).toEqual({
    source: "capsule_blueprint",
    key: "main-mcp",
  });

  await expect(
    migration.confirm({
      ...candidate!,
      confirmedBy: "operator_1",
      selection: {
        name: "replacement",
        type: "mcp.server",
        version: "1",
        document: {},
        inputName: "endpoint",
        outputName: "launch_url",
        access: { visibility: "private" },
      },
    }),
  ).rejects.toMatchObject<Partial<LegacyOutputInterfaceMigrationError>>({
    code: "invalid_selection",
  });
});

test("post-v1 materialized blueprints without retired Outputs are not migration candidates", async () => {
  const { migration, opentofu } = await fixture({ blueprints: true });
  await opentofu.putOutput({
    id: "out_legacy",
    workspaceId: "workspace_migration",
    capsuleId: "cap_legacy",
    stateGeneration: 1,
    rawArtifactRef: "sealed/out_legacy",
    publicOutputs: { launch_url: "https://current.example.test/mcp" },
    workspaceOutputs: { launch_url: "https://current.example.test/mcp" },
    outputDigest: `sha256:${"c".repeat(64)}`,
    createdAt: NOW,
  });
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  expect(candidate?.mode).toBe("service_blueprints");
  await migration.confirm({ ...candidate!, confirmedBy: "operator_1" });

  expect((await migration.report("workspace_migration")).candidates).toEqual(
    [],
  );
});

test("confirmation fails closed when the reviewed Capsule fence changes", async () => {
  const { migration, opentofu } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;
  await opentofu.patchCapsule("cap_legacy", {
    updatedAt: "2026-07-14T12:00:01.000Z",
  });

  await expect(
    migration.confirm({
      ...candidate!,
      confirmedBy: "operator_1",
      selection: {
        name: "main-mcp",
        type: "mcp.server",
        version: "2025-11-25",
        document: {},
        inputName: "endpoint",
        outputName: "launch_url",
        access: { visibility: "private" },
      },
    }),
  ).rejects.toMatchObject<Partial<LegacyOutputInterfaceMigrationError>>({
    code: "candidate_changed",
  });
});

test("confirmation is fenced to the route Workspace before materialization", async () => {
  const { migration, interfaces } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;

  await expect(
    migration.confirm(
      {
        ...candidate!,
        confirmedBy: "operator_1",
        selection: {
          name: "main-mcp",
          type: "mcp.server",
          version: "2025-11-25",
          document: {},
          inputName: "endpoint",
          outputName: "launch_url",
          access: { visibility: "private" },
        },
      },
      "workspace_foreign",
    ),
  ).rejects.toMatchObject<Partial<LegacyOutputInterfaceMigrationError>>({
    code: "candidate_not_found",
  });
  expect(
    await interfaces.list({
      workspaceId: "workspace_migration",
      ownerKind: "Capsule",
      ownerId: "cap_legacy",
      includeRetired: true,
    }),
  ).toEqual([]);
});

test("unknown convention never guesses and rejects secret-shaped selections", async () => {
  const { migration } = await fixture();
  const [candidate] = (await migration.report("workspace_migration"))
    .candidates;

  await expect(
    migration.confirm({ ...candidate!, confirmedBy: "operator_1" }),
  ).rejects.toMatchObject<Partial<LegacyOutputInterfaceMigrationError>>({
    code: "invalid_selection",
  });
  await expect(
    migration.confirm({
      ...candidate!,
      confirmedBy: "operator_1",
      selection: {
        name: "unsafe",
        type: "mcp.server",
        version: "1",
        document: {},
        inputName: "credential",
        outputName: "admin_token",
        access: { visibility: "private" },
      },
    }),
  ).rejects.toMatchObject<Partial<LegacyOutputInterfaceMigrationError>>({
    code: "invalid_selection",
  });
});
