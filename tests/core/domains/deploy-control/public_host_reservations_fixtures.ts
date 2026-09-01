import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

async function seedWorkspace(
  store: OpenTofuControlStore,
  id: string,
  ownerUserId: string,
): Promise<void> {
  await store.putWorkspace({
    id,
    handle: id.replaceAll("_", "-"),
    displayName: id,
    type: "personal",
    ownerUserId,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  });
}

async function seedCapsule(
  store: OpenTofuControlStore,
  id: string,
  workspaceId: string,
  status: "pending" | "destroyed" = "pending",
): Promise<void> {
  await store.putCapsule({
    id,
    workspaceId,
    projectId: `project_${workspaceId}`,
    name: id,
    slug: id,
    sourceId: `source_${id}`,
    installConfigId: `config_${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  });
}

export { seedCapsule, seedWorkspace };
