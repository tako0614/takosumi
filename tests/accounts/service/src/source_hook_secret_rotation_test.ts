import { expect, test } from "bun:test";
import type { ActivityEvent } from "../../../../contract/activity.ts";
import type { Source } from "../../../../contract/sources.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import {
  InMemoryAccountsStore,
  type PersonalAccessTokenRecord,
} from "../../../../accounts/service/src/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { sha256HexOfStringAsync } from "../../../../core/shared/runtime/hash.ts";

const workspaceId = "ws_hook_rotation";
const sourceId = "src_hook_rotation";
const ownerId = "tsub_hook_owner";
const adminId = "tsub_hook_admin";
const memberId = "tsub_hook_member";
const PAT_NOW = Date.now();

const workspace = {
  id: workspaceId,
  handle: "hook-rotation",
  displayName: "Hook Rotation",
  type: "organization" as const,
  ownerUserId: ownerId,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

interface RotationResponse {
  readonly source: Source;
  readonly hookSecret: string;
}

function saveAccount(accounts: InMemoryAccountsStore, subject: string): void {
  accounts.saveAccount({
    subject,
    createdAt: PAT_NOW,
    updatedAt: PAT_NOW,
  });
}

function saveSession(
  accounts: InMemoryAccountsStore,
  subject: string,
  token: string,
): void {
  saveAccount(accounts, subject);
  accounts.saveAccountSession({
    sessionId: token,
    subject,
    createdAt: PAT_NOW,
    expiresAt: PAT_NOW + 60_000,
  });
}

function savePat(
  accounts: InMemoryAccountsStore,
  input: {
    readonly token: string;
    readonly tokenId: string;
    readonly subject: string;
    readonly scopes: PersonalAccessTokenRecord["scopes"];
    readonly workspaceId?: string;
  },
): void {
  saveAccount(accounts, input.subject);
  accounts.savePersonalAccessToken(input.token, {
    tokenId: input.tokenId,
    tokenPrefix: input.tokenId,
    subject: input.subject,
    name: "Source hook rotation test",
    scopes: input.scopes,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    createdAt: PAT_NOW,
  });
}

async function fixture() {
  const controlStore = new InMemoryOpenTofuControlStore();
  await controlStore.putWorkspace(workspace);
  await controlStore.putWorkspaceMember({
    id: "wsm_hook_admin",
    workspaceId,
    accountId: adminId,
    roles: ["admin"],
    status: "active",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  await controlStore.putWorkspaceMember({
    id: "wsm_hook_member",
    workspaceId,
    accountId: memberId,
    roles: ["member"],
    status: "active",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });

  const workspaces = new WorkspacesService({ store: controlStore });
  const sources = new SourcesService({
    store: controlStore,
    newId: () => sourceId,
  });
  const created = await sources.createSource({
    workspaceId,
    name: "webhook source",
    url: "https://github.com/example/hook-rotation.git",
  });
  const operations = {
    workspaces: {
      getWorkspace: workspaces.getWorkspace.bind(workspaces),
      captureManagementAuthority:
        workspaces.captureManagementAuthority.bind(workspaces),
    },
    members: {
      getMember: async (targetWorkspaceId: string, accountId: string) =>
        await controlStore.getWorkspaceMember(targetWorkspaceId, accountId),
    },
    getSource: sources.getSource.bind(sources),
    listSources: sources.listSources.bind(sources),
    rotateSourceHookSecret: async (id: string, actorId?: string) => {
      const service = sources as unknown as {
        rotateSourceHookSecret(
          sourceId: string,
          actor?: string,
        ): Promise<RotationResponse>;
      };
      return await service.rotateSourceHookSecret(id, actorId);
    },
    activity: {
      list: async (targetWorkspaceId: string, limit?: number) =>
        await controlStore.listActivityEvents(targetWorkspaceId, limit),
    },
  } as unknown as ControlPlaneOperations;
  return {
    accounts: new InMemoryAccountsStore(),
    controlStore,
    operations,
    sources,
    originalSecret: created.hookSecret,
  };
}

async function request(
  state: Awaited<ReturnType<typeof fixture>>,
  input: {
    readonly token?: string;
    readonly path?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<Response> {
  const url = new URL(
    `https://app.example.test${input.path ?? `/api/v1/sources/${sourceId}/hook-secret/rotate`}`,
  );
  const response = await handleControlRoute({
    request: new Request(url, {
      method: input.method ?? "POST",
      ...(input.token || input.headers
        ? {
            headers: {
              ...input.headers,
              ...(input.token
                ? { authorization: `Bearer ${input.token}` }
                : {}),
            },
          }
        : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }),
    url,
    store: state.accounts,
    operations: state.operations,
  });
  expect(response).toBeDefined();
  return response!;
}

test("Source hook secret rotation authorizes owner, admin, and write PAT and returns one random bearer", async () => {
  for (const actor of ["owner", "admin", "write-pat"] as const) {
    const state = await fixture();
    let token: string;
    if (actor === "owner") {
      token = "session_hook_owner";
      saveSession(state.accounts, ownerId, token);
    } else if (actor === "admin") {
      token = "session_hook_admin";
      saveSession(state.accounts, adminId, token);
    } else {
      token = "pat_hook_write";
      savePat(state.accounts, {
        token,
        tokenId: "pat_hook_write",
        subject: ownerId,
        scopes: ["write"],
        workspaceId,
      });
    }

    const response = await request(state, { token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as RotationResponse;
    expect(body.source.id).toBe(sourceId);
    expect(body.source.workspaceId).toBe(workspaceId);
    expect(body.hookSecret).toMatch(/^whk_[0-9a-f]{64}$/u);
    expect(body.hookSecret).not.toBe(state.originalSecret);

    const stored = await state.controlStore.getSource(sourceId);
    expect(stored?.hookSecretHash).toBeDefined();
    expect(stored?.hookSecretHash).toBe(
      await sha256HexOfStringAsync(body.hookSecret),
    );
    expect(await state.sources.verifyHookSecret(sourceId, state.originalSecret)).toBe(false);
    expect(await state.sources.verifyHookSecret(sourceId, body.hookSecret)).toBe(true);
    expect(JSON.stringify(body.source)).not.toContain("hookSecret");
    expect(JSON.stringify(body.source)).not.toContain("hookSecretHash");

    const getSource = await request(state, {
      token,
      method: "GET",
      path: `/api/v1/sources/${sourceId}`,
    });
    const sourceJson = await getSource.json();
    expect(JSON.stringify(sourceJson)).not.toContain(body.hookSecret);
    expect(JSON.stringify(sourceJson)).not.toContain("hookSecretHash");

    const listSources = await request(state, {
      token,
      method: "GET",
      path: `/api/v1/sources?workspaceId=${workspaceId}`,
    });
    const listJson = await listSources.json();
    expect(JSON.stringify(listJson)).not.toContain(body.hookSecret);
    expect(JSON.stringify(listJson)).not.toContain("hookSecretHash");

    const activityEvents = await state.controlStore.listActivityEvents(
      workspaceId,
    );
    const rotationEvent = activityEvents.find(
      (event) => event.action === "source.hook_secret_rotated",
    );
    expect(rotationEvent).toMatchObject({
      workspaceId,
      actorId: actor === "admin" ? adminId : ownerId,
      targetType: "source",
      targetId: sourceId,
      metadata: {},
    });
    expect(JSON.stringify(activityEvents)).not.toContain(body.hookSecret);
  }
});

test("Source hook secret rotation rejects unauthenticated, read-only, member, absent-member, and mismatched scoped callers", async () => {
  const cases = [
    { label: "unauthenticated", status: 401 },
    { label: "read-only PAT", token: "pat_hook_read", status: 403 },
    { label: "member session", token: "session_hook_member", status: 403 },
    { label: "no membership", token: "session_hook_stranger", status: 403 },
    { label: "workspace-scoped mismatch", token: "pat_hook_other_workspace", status: 403 },
  ] as const;

  for (const candidate of cases) {
    const state = await fixture();
    const before = await state.controlStore.getSource(sourceId);
    if (candidate.label === "read-only PAT") {
      savePat(state.accounts, {
        token: candidate.token,
        tokenId: "pat_hook_read",
        subject: ownerId,
        scopes: ["read"],
        workspaceId,
      });
    } else if (candidate.label === "member session") {
      saveSession(state.accounts, memberId, candidate.token);
    } else if (candidate.label === "no membership") {
      saveSession(state.accounts, "tsub_hook_stranger", candidate.token);
    } else if (candidate.label === "workspace-scoped mismatch") {
      savePat(state.accounts, {
        token: candidate.token,
        tokenId: "pat_hook_other_workspace",
        subject: ownerId,
        scopes: ["write"],
        workspaceId: "ws_other_hook_rotation",
      });
    }

    const response = await request(state, {
      ...(candidate.token ? { token: candidate.token } : {}),
    });
    expect(response.status, candidate.label).toBe(candidate.status);
    expect(await state.controlStore.getSource(sourceId)).toMatchObject({
      hookSecretHash: before?.hookSecretHash,
    });
  }
});

test("Source hook secret rotation rejects request bodies, including secret replacement values", async () => {
  const state = await fixture();
  const before = await state.controlStore.getSource(sourceId);
  const token = "session_hook_owner_body";
  saveSession(state.accounts, ownerId, token);

  const response = await request(state, {
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hookSecret: "caller-selected-secret" }),
  });

  expect(response.status).toBe(400);
  expect(await state.controlStore.getSource(sourceId)).toMatchObject({
    hookSecretHash: before?.hookSecretHash,
  });
  expect(await state.controlStore.listActivityEvents(workspaceId)).toHaveLength(0);
});
