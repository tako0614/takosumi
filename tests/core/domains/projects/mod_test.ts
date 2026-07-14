import { expect, test } from "bun:test";
import {
  defaultProjectId,
  InMemoryProjectStore,
  ProjectsService,
} from "../../../../core/domains/projects/mod.ts";

test("default Project identity is deterministic and Workspace-scoped", async () => {
  const store = new InMemoryProjectStore();
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
