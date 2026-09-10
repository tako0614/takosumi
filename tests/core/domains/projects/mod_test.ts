import { expect, test } from "bun:test";
import {
  defaultProjectId,
  ProjectsService,
} from "../../../../core/domains/projects/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const NOW = "2026-07-13T00:00:00.000Z";

async function seedWorkspace(store: InMemoryOpenTofuControlStore, id: string) {
  await store.putWorkspace({
    id, handle: id, displayName: id, type: "personal", ownerUserId: `owner_${id}`,
    createdAt: NOW, updatedAt: NOW,
  });
}

test("default Project identity is deterministic and Workspace-scoped", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store, "ws_first");
  await seedWorkspace(store, "ws_second");
  const service = new ProjectsService({
    store,
    now: () => new Date("2026-07-13T00:00:00.000Z"),
  });

  const first = await service.ensureDefaultProject("ws_first");
  const second = await service.ensureDefaultProject("ws_second");
  const replay = await service.ensureDefaultProject("ws_first");

  expect(first.id).toBe(defaultProjectId("ws_first"));
  expect(second.id).toBe(defaultProjectId("ws_second"));
  expect(first.id).not.toBe(second.id);
  expect(replay).toEqual(first);
  expect(await store.listProjectsByWorkspace("ws_first")).toEqual([first]);
  expect(await store.listProjectsByWorkspace("ws_second")).toEqual([second]);
});

test("Project creation refuses a stopped Workspace while retaining existing default lookup", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store, "ws_stopped");
  const service = new ProjectsService({ store, now: () => new Date(NOW) });
  const existing = await service.ensureDefaultProject("ws_stopped");
  await store.beginWorkspaceDraining("ws_stopped", {
    workspaceId: "ws_stopped", managementState: "active", managementEpoch: 1,
  });
  await expect(service.createProject({ workspaceId: "ws_stopped", name: "Denied", slug: "denied" }))
    .rejects.toMatchObject({ code: "failed_precondition", details: { reason: "workspace_management_admission_conflict" } });
  expect(await service.ensureDefaultProject("ws_stopped")).toEqual(existing);
  expect(await service.listProjects("ws_stopped")).toEqual([existing]);
});

test("listProjects observes an empty stopped Workspace without creating its default", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store, "ws_empty_stopped");
  const service = new ProjectsService({ store, now: () => new Date(NOW) });
  await expect(service.ensureDefaultProject("ws_empty_stopped", {
    workspaceId: "ws_empty_stopped", managementState: "active", managementEpoch: 2,
  })).rejects.toMatchObject({ code: "failed_precondition", details: { reason: "workspace_management_admission_conflict" } });
  expect(
    await store.beginWorkspaceDraining("ws_empty_stopped", {
      workspaceId: "ws_empty_stopped",
      managementState: "active",
      managementEpoch: 1,
    }),
  ).toMatchObject({ status: "started" });
  expect(await service.listProjects("ws_empty_stopped")).toEqual([]);
  expect(
    await store.getProject(defaultProjectId("ws_empty_stopped")),
  ).toBeUndefined();
});

test("concurrent default creators adopt one canonical row without overwriting its timestamp", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store, "ws_concurrent_default");
  const first = new ProjectsService({
    store,
    now: () => new Date("2026-07-13T00:00:01.000Z"),
  });
  const second = new ProjectsService({
    store,
    now: () => new Date("2026-07-13T00:00:02.000Z"),
  });

  const [created, adopted] = await Promise.all([
    first.ensureDefaultProject("ws_concurrent_default"),
    second.ensureDefaultProject("ws_concurrent_default"),
  ]);

  expect(adopted).toEqual(created);
  expect(
    await store.listProjectsByWorkspace("ws_concurrent_default"),
  ).toEqual([created]);
  expect(created.createdAt).toBe("2026-07-13T00:00:01.000Z");
});

test("concurrent custom Project creators preserve the duplicate-slug error", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store, "ws_concurrent_slug");
  const first = new ProjectsService({
    store,
    newId: () => "prj_first",
    now: () => new Date("2026-07-13T00:00:01.000Z"),
  });
  const second = new ProjectsService({
    store,
    newId: () => "prj_second",
    now: () => new Date("2026-07-13T00:00:02.000Z"),
  });

  const outcomes = await Promise.allSettled([
    first.createProject({
      workspaceId: "ws_concurrent_slug",
      name: "One",
      slug: "shared",
    }),
    second.createProject({
      workspaceId: "ws_concurrent_slug",
      name: "Two",
      slug: "shared",
    }),
  ]);
  const fulfilled = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<ProjectsService["createProject"]>>> =>
      outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({
    code: "failed_precondition",
    message: "project already exists",
  });
  expect(
    await store.listProjectsByWorkspace("ws_concurrent_slug"),
  ).toHaveLength(1);
});
