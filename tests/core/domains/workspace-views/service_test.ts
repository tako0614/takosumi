import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { ActorContext } from "takosumi-contract";
import type { Page } from "takosumi-contract/pagination";
import type { WorkspaceMember } from "takosumi-contract/workspaces";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import { WorkspaceViewsService } from "../../../../core/domains/workspace-views/mod.ts";

const timestamp = "2026-08-03T00:00:00.000Z";

test("owner read resolves one control store and returns redacted live projections", async () => {
  let factoryCalls = 0;
  let availabilityActor: ActorContext | undefined;
  const capsule = {
    id: "cap_1",
    workspaceId: "ws_1",
    projectId: "prj_1",
    name: "api",
    slug: "api",
    sourceId: "src_1",
    installConfigId: "cfg_1",
    installingPrincipalId: "owner_1",
    environment: "production",
    currentStateGeneration: 2,
    currentOutputId: "out_secret_pointer",
    autoUpdateAttemptSourceSnapshotId: "snap_internal",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies Capsule;
  const resource = {
    id: "tkrn:ws_1:EdgeWorker:api",
    spaceId: "ws_1",
    project: "api",
    environment: "production",
    kind: "EdgeWorker",
    name: "api",
    managedBy: "opentofu",
    owner: {
      kind: "Capsule",
      id: capsule.id,
      workspaceId: "ws_1",
      installingPrincipalId: "owner_1",
    },
    spec: { secretLookingInput: "must-not-leak" },
    phase: "Ready",
    generation: 2,
    observedGeneration: 2,
    outputs: { token: "must-not-leak" },
    conditions: [{ type: "Ready", status: "true", message: "internal" }],
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies ResourceShapeRecord;
  const store = {
    getWorkspace: async () => ({
      id: "ws_1",
      handle: "workspace-one",
      displayName: "Workspace One",
      type: "organization",
      ownerUserId: "owner_1",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    getWorkspaceMember: async () => undefined,
    listCapsulesPage: async () => ({ items: [capsule] }),
  } as unknown as OpenTofuControlStore;
  const service = new WorkspaceViewsService({
    controlStoreFactory: () => {
      factoryCalls += 1;
      return store;
    },
    resourceStores: {
      resources: {
        listBySpacePage: async () => ({ items: [resource] }),
      } as never,
      locks: {
        getMany: async () => [
          {
            resourceId: resource.id,
            selectedImplementation: "cloudflare_workers",
            target: "cloudflare-main",
            locked: true,
            reason: ["test"],
            portability: "mostly_portable",
            lockedAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      } as never,
      targetPools: {
        listBySpacePage: async () => ({
          items: [
            {
              id: "tkrn:ws_1:TargetPool:default",
              spaceId: "ws_1",
              name: "default",
              spec: {},
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        }),
      } as never,
    },
    resourceShapeService: {
      readFormAvailability: async (input) => {
        availabilityActor = input.actor;
        return { forms: { items: [] }, hasTargetPool: true };
      },
    },
  });

  const result = await service.readResources({
    workspaceId: "ws_1",
    space: "ws_1",
    subject: "owner_1",
    requiredAccess: "read",
    page: { limit: 25 },
  });

  expect(factoryCalls).toBe(1);
  expect(availabilityActor).toMatchObject({
    actorAccountId: "owner_1",
    workspaceId: "ws_1",
    roles: ["owner"],
  });
  expect(result.hasTargetPool).toBe(true);
  expect(result.forms.items).toEqual([]);
  expect(result.resources.items).toEqual([
    {
      id: resource.id,
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "EdgeWorker",
      metadata: {
        name: "api",
        space: "ws_1",
        project: "api",
        environment: "production",
        managedBy: "opentofu",
      },
      status: {
        phase: "Ready",
        observedGeneration: 2,
        resolution: {
          selectedImplementation: "cloudflare_workers",
          target: "cloudflare-main",
          locked: true,
          portability: "mostly_portable",
        },
      },
    },
  ]);
  expect(result.workloads.items[0]).not.toHaveProperty("currentOutputId");
  expect(result.workloads.items[0]).not.toHaveProperty(
    "autoUpdateAttemptSourceSnapshotId",
  );
  expect(result.workloads.items[0]).not.toHaveProperty(
    "installingPrincipalId",
  );
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
  expect(result.nextCursor).toBeUndefined();
});

test("credential and namespace restrictions deny before every durable read", async () => {
  const harness = workspaceViewHarness();

  await expect(
    harness.service.readResources({
      workspaceId: "ws_1",
      space: "ws_1",
      subject: "member_1",
      credentialWorkspaceId: "ws_other",
      requiredAccess: "read",
      page: {},
    }),
  ).rejects.toMatchObject({ code: "workspace_view_access_denied" });
  expect(harness.counts).toEqual({ factory: 1, workspace: 0, member: 0, data: 0 });

  await expect(
    harness.service.readResources({
      workspaceId: "ws_1",
      space: "space_other",
      subject: "member_1",
      requiredAccess: "read",
      page: {},
    }),
  ).rejects.toMatchObject({ code: "workspace_view_access_denied" });
  expect(harness.counts).toEqual({ factory: 2, workspace: 0, member: 0, data: 0 });
});

test("active members can read, only canonical owner or active admin can write", async () => {
  const member = workspaceViewHarness({
    member: workspaceMember("member_1", ["viewer"], "active"),
  });
  await expect(member.read("read")).resolves.toMatchObject({
    view: "resources.v1",
  });
  await expect(member.read("write")).rejects.toMatchObject({
    code: "workspace_view_access_denied",
  });
  expect(member.counts.data).toBe(4);

  const admin = workspaceViewHarness({
    member: workspaceMember("member_1", ["admin"], "active"),
  });
  await expect(admin.read("write")).resolves.toMatchObject({
    view: "resources.v1",
  });
  expect(admin.availabilityActors[0]?.roles).toEqual(["admin"]);

  const staleOwnerRole = workspaceViewHarness({
    member: workspaceMember("member_1", ["owner"], "active"),
  });
  await expect(staleOwnerRole.read("read")).resolves.toBeDefined();
  expect(staleOwnerRole.availabilityActors[0]?.roles).toEqual([]);
  await expect(staleOwnerRole.read("write")).rejects.toMatchObject({
    code: "workspace_view_access_denied",
  });
});

test.each([
  ["suspended member", workspaceMember("member_1", ["admin"], "suspended")],
  ["invited member", workspaceMember("member_1", ["viewer"], "invited")],
  ["nonmember", undefined],
] as const)("%s is denied without projection reads", async (_label, member) => {
  const harness = workspaceViewHarness({ member });
  await expect(harness.read("read")).rejects.toMatchObject({
    code: "workspace_view_access_denied",
  });
  expect(harness.counts).toEqual({ factory: 1, workspace: 1, member: 1, data: 0 });
});

test("projection failure propagates and is never converted to an empty view", async () => {
  const failure = new Error("resource store unavailable");
  const harness = workspaceViewHarness({ resourceFailure: failure });
  await expect(harness.read("read")).rejects.toBe(failure);
  expect(harness.counts.data).toBe(4);
});

test("abort is honored before reads and again after concurrent reads", async () => {
  const before = workspaceViewHarness();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(
    before.service.readResources({
      workspaceId: "ws_1",
      space: "ws_1",
      subject: "member_1",
      requiredAccess: "read",
      page: {},
      signal: alreadyAborted.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(before.counts).toEqual({ factory: 1, workspace: 0, member: 0, data: 0 });

  const afterController = new AbortController();
  const after = workspaceViewHarness({
    afterDataRead: () => afterController.abort(),
  });
  await expect(
    after.service.readResources({
      workspaceId: "ws_1",
      space: "ws_1",
      subject: "member_1",
      requiredAccess: "read",
      page: {},
      signal: afterController.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(after.counts.data).toBe(4);
});

test("composite cursor advances child pages independently without replaying exhausted output", async () => {
  const resourceCursors: (string | undefined)[] = [];
  const workloadCursors: (string | undefined)[] = [];
  const formCursors: (string | undefined)[] = [];
  let workloadCalls = 0;
  const harness = workspaceViewHarness({
    resourcePage: (cursor) => {
      resourceCursors.push(cursor);
      return cursor === undefined
        ? { items: [resourceRecord("resource_first")], nextCursor: "res_next" }
        : { items: [resourceRecord("resource_second")] };
    },
    workloadPage: (cursor) => {
      workloadCursors.push(cursor);
      workloadCalls += 1;
      return { items: [capsuleRecord(`capsule_${workloadCalls}`)] };
    },
    formPage: (cursor) => {
      formCursors.push(cursor);
      return cursor === undefined
        ? { items: [], nextCursor: "form_next" }
        : { items: [] };
    },
  });

  const first = await harness.read("read");
  expect(first.nextCursor).toBeString();
  expect(first.resources.nextCursor).toBe("res_next");
  expect(first.forms.nextCursor).toBe("form_next");
  expect(first.workloads.items).toHaveLength(1);

  const second = await harness.service.readResources({
    workspaceId: "ws_1",
    space: "ws_1",
    subject: "member_1",
    requiredAccess: "read",
    page: { cursor: first.nextCursor, limit: 999 },
  });
  expect(resourceCursors).toEqual([undefined, "res_next"]);
  expect(formCursors).toEqual([undefined, "form_next"]);
  // The envelope's terminal marker prevents both a durable re-read and a
  // replay of the exhausted child page.
  expect(workloadCursors).toEqual([undefined]);
  expect(second.workloads.items).toEqual([]);
  expect(second.resources.items[0]?.id).toBe("resource_second");
  expect(second.nextCursor).toBeUndefined();
});

test("malformed, foreign, and wrong-version cursors use the typed cursor error", async () => {
  const harness = workspaceViewHarness();
  for (const cursor of [
    "not+base64",
    btoa(JSON.stringify({ c: timestamp, i: "foreign-list-cursor" })),
    base64Url(
      JSON.stringify({
        view: "takosumi.workspace-resources",
        version: 2,
        resources: "r",
        workloads: null,
        forms: null,
      }),
    ),
  ]) {
    await expect(
      harness.service.readResources({
        workspaceId: "ws_1",
        space: "ws_1",
        subject: "member_1",
        requiredAccess: "read",
        page: { cursor },
      }),
    ).rejects.toMatchObject({ code: "workspace_view_cursor_invalid" });
  }
  expect(harness.counts.workspace).toBe(0);
});

test("concurrent view reads each retain one distinct factory result", async () => {
  const stores: OpenTofuControlStore[] = [];
  const base = workspaceViewHarness({
    controlStoreFactory: () => {
      const store = workspaceViewControlStore();
      stores.push(store);
      return store;
    },
  });
  await Promise.all([base.read("read"), base.read("read")]);
  expect(stores).toHaveLength(2);
  expect(stores[0]).not.toBe(stores[1]);
  expect(base.counts.factory).toBe(2);
});

test("the four bounded data reads start concurrently after authorization", async () => {
  const started = new Set<string>();
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  const harness = workspaceViewHarness({
    resourcePage: async () => {
      started.add("resources");
      await gates[0]!.promise;
      return { items: [] };
    },
    workloadPage: async () => {
      started.add("workloads");
      await gates[1]!.promise;
      return { items: [] };
    },
    formPage: async () => {
      started.add("forms");
      await gates[2]!.promise;
      return { items: [] };
    },
    targetPoolPage: async () => {
      started.add("targetPools");
      await gates[3]!.promise;
      return { items: [] };
    },
  });

  const reading = harness.read("read");
  await Bun.sleep(0);
  expect(started).toEqual(
    new Set(["resources", "workloads", "forms", "targetPools"]),
  );
  for (const gate of gates) gate.resolve();
  await expect(reading).resolves.toBeDefined();
});

interface HarnessOptions {
  readonly member?: WorkspaceMember;
  readonly resourceFailure?: Error;
  readonly afterDataRead?: () => void;
  readonly controlStoreFactory?: () => OpenTofuControlStore;
  readonly resourcePage?: (
    cursor: string | undefined,
  ) => Page<ResourceShapeRecord> | Promise<Page<ResourceShapeRecord>>;
  readonly workloadPage?: (
    cursor: string | undefined,
  ) => Page<Capsule> | Promise<Page<Capsule>>;
  readonly formPage?: (
    cursor: string | undefined,
  ) => Page<never> | Promise<Page<never>>;
  readonly targetPoolPage?: () => Page<never> | Promise<Page<never>>;
  readonly locksPage?: (
    resourceIds: readonly string[],
  ) =>
    | readonly ResolutionLockRecord[]
    | Promise<readonly ResolutionLockRecord[]>;
}

function workspaceViewHarness(options: HarnessOptions = {}) {
  const counts = { factory: 0, workspace: 0, member: 0, data: 0 };
  const availabilityActors: ActorContext[] = [];
  const member = Object.hasOwn(options, "member")
    ? options.member
    : workspaceMember("member_1", ["viewer"], "active");
  const controlStore = workspaceViewControlStore({
    getWorkspace: async () => {
      counts.workspace += 1;
      return {
        id: "ws_1",
        handle: "workspace-one",
        displayName: "Workspace One",
        type: "organization",
        ownerUserId: "owner_1",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
    getWorkspaceMember: async () => {
      counts.member += 1;
      return member;
    },
    listCapsulesPage: async (_workspaceId, params) => {
      counts.data += 1;
      return (
        (await options.workloadPage?.(params.cursor)) ?? { items: [] }
      );
    },
  });
  const service = new WorkspaceViewsService({
    controlStoreFactory: () => {
      counts.factory += 1;
      return options.controlStoreFactory?.() ?? controlStore;
    },
    resourceStores: {
      resources: {
        listBySpacePage: async (_space, params) => {
          counts.data += 1;
          if (options.resourceFailure) throw options.resourceFailure;
          return (
            (await options.resourcePage?.(params.cursor)) ?? { items: [] }
          );
        },
      } as never,
      locks: {
        getMany: async (resourceIds: readonly string[]) => {
          counts.data += 1;
          return (await options.locksPage?.(resourceIds)) ?? [];
        },
      } as never,
      targetPools: {
        listBySpacePage: async () => {
          counts.data += 1;
          const page = (await options.targetPoolPage?.()) ?? { items: [] };
          options.afterDataRead?.();
          return page;
        },
      } as never,
    },
    resourceShapeService: {
      readFormAvailability: async (input) => {
        counts.data += 1;
        availabilityActors.push(input.actor);
        const formsRead = options.formPage?.(input.page?.cursor) ?? {
          items: [],
        };
        counts.data += 1;
        const targetPoolsRead = options.targetPoolPage?.() ?? { items: [] };
        const [forms, targetPools] = await Promise.all([
          formsRead,
          targetPoolsRead,
        ]);
        options.afterDataRead?.();
        return {
          forms,
          hasTargetPool: targetPools.items.length > 0,
        };
      },
    },
  });
  return {
    service,
    counts,
    availabilityActors,
    read: (requiredAccess: "read" | "write") =>
      service.readResources({
        workspaceId: "ws_1",
        space: "ws_1",
        subject: "member_1",
        requiredAccess,
        page: {},
      }),
  };
}

function workspaceViewControlStore(
  methods: Partial<OpenTofuControlStore> = {},
): OpenTofuControlStore {
  return {
    getWorkspace: async () => ({
      id: "ws_1",
      handle: "workspace-one",
      displayName: "Workspace One",
      type: "organization",
      ownerUserId: "owner_1",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    getWorkspaceMember: async () =>
      workspaceMember("member_1", ["viewer"], "active"),
    listCapsulesPage: async () => ({ items: [] }),
    ...methods,
  } as unknown as OpenTofuControlStore;
}

function workspaceMember(
  accountId: string,
  roles: WorkspaceMember["roles"],
  status: WorkspaceMember["status"],
): WorkspaceMember {
  return {
    id: `member_${accountId}`,
    workspaceId: "ws_1",
    accountId,
    roles,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function capsuleRecord(id: string): Capsule {
  return {
    id,
    workspaceId: "ws_1",
    projectId: "prj_1",
    name: id,
    slug: id,
    sourceId: "src_1",
    installConfigId: "cfg_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function resourceRecord(id: string): ResourceShapeRecord {
  return {
    id,
    spaceId: "ws_1",
    kind: "EdgeWorker",
    name: id,
    managedBy: "opentofu",
    spec: {},
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function base64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
