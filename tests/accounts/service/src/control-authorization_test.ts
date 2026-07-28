import { expect, test } from "bun:test";

import {
  handleControlRoute,
  type ControlPlaneOperations,
} from "../../../../accounts/service/src/control-routes.ts";
import { createAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const ORIGIN = "https://app.example.test";
const ACTOR = "tsub_actor";

const workspaces = {
  alpha: {
    id: "ws_alpha",
    handle: "alpha",
    displayName: "Alpha",
    type: "team" as const,
    ownerUserId: ACTOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  beta: {
    id: "ws_beta",
    handle: "beta",
    displayName: "Beta",
    type: "team" as const,
    ownerUserId: ACTOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

function operationsFixture() {
  const projectCreates: Array<{ readonly workspaceId: string }> = [];
  const operations = {
    workspaces: {
      getWorkspace: async (workspaceId: string) => {
        const workspace = Object.values(workspaces).find(
          (candidate) => candidate.id === workspaceId,
        );
        if (!workspace) throw new Error("workspace not found");
        return workspace;
      },
      listWorkspacesForAccount: async () => Object.values(workspaces),
    },
    members: {
      listMembers: async () => [],
    },
    projects: {
      createProject: async (input: {
        readonly workspaceId: string;
        readonly name: string;
        readonly slug: string;
      }) => {
        projectCreates.push(input);
        return {
          id: "prj_created",
          ...input,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    },
  } as unknown as ControlPlaneOperations;
  return { operations, projectCreates };
}

function viewerOperationsFixture() {
  const projectCreates: Array<{ readonly workspaceId: string }> = [];
  const viewerWorkspace = {
    ...workspaces.alpha,
    ownerUserId: "tsub_owner",
  };
  const operations = {
    workspaces: {
      getWorkspace: async () => viewerWorkspace,
      listWorkspacesForAccount: async () => [viewerWorkspace],
      updateWorkspace: async (
        _workspaceId: string,
        patch: { readonly displayName?: string },
      ) => ({ ...viewerWorkspace, ...patch }),
    },
    members: {
      listMembers: async () => [
        {
          id: "wsm_viewer",
          workspaceId: viewerWorkspace.id,
          accountId: ACTOR,
          roles: ["viewer"],
          status: "active",
          createdAt: viewerWorkspace.createdAt,
          updatedAt: viewerWorkspace.updatedAt,
        },
      ],
    },
    projects: {
      createProject: async (input: {
        readonly workspaceId: string;
        readonly name: string;
        readonly slug: string;
      }) => {
        projectCreates.push(input);
        return {
          id: "prj_created",
          ...input,
          createdAt: viewerWorkspace.createdAt,
          updatedAt: viewerWorkspace.updatedAt,
        };
      },
    },
    activity: {
      record: async () => undefined,
    },
  } as unknown as ControlPlaneOperations;
  return { operations, projectCreates, workspace: viewerWorkspace };
}

async function dispatchControl(input: {
  readonly request: Request;
  readonly store: InMemoryAccountsStore;
  readonly operations: ControlPlaneOperations;
}): Promise<Response> {
  const response = await handleControlRoute({
    request: input.request,
    url: new URL(input.request.url),
    store: input.store,
    operations: input.operations,
  });
  if (!response) throw new Error("control route did not dispatch");
  return response;
}

function seedSession(
  store: InMemoryAccountsStore,
  subject: string,
  sessionId: string,
): void {
  const now = Date.now();
  store.saveAccount({ subject, createdAt: now, updatedAt: now });
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

test("Workspace-bound PAT cannot mutate another Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const token = "takpat_workspace_alpha";
  store.saveAccount({
    subject: ACTOR,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.savePersonalAccessToken(token, {
    tokenId: "pat_workspace_alpha",
    tokenPrefix: "takpat_work",
    subject: ACTOR,
    name: "Alpha automation",
    scopes: ["write"],
    workspaceId: workspaces.alpha.id,
    createdAt: Date.now(),
  });
  const fixture = operationsFixture();

  const response = await dispatchControl({
    store,
    operations: fixture.operations,
    request: new Request(
      `${ORIGIN}/api/v1/workspaces/${workspaces.beta.id}/projects`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Escape", slug: "escape" }),
      },
    ),
  });

  expect(response.status).toBe(403);
  expect(fixture.projectCreates).toHaveLength(0);
});

test("self-service PAT creation cannot grant the admin scope", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = "sess_pat_scope_escalation";
  seedSession(store, ACTOR, sessionId);
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
  });

  const response = await handler(
    new Request(`${ORIGIN}/v1/account/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Escalated token",
        scopes: ["read", "admin"],
      }),
    }),
  );

  expect(response.status).toBe(403);
  expect(await store.listPersonalAccessTokensForSubject(ACTOR)).toHaveLength(0);
});

test("viewer cannot create a Project in the viewed Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = "sess_workspace_viewer";
  seedSession(store, ACTOR, sessionId);
  const fixture = viewerOperationsFixture();

  const response = await dispatchControl({
    store,
    operations: fixture.operations,
    request: new Request(
      `${ORIGIN}/api/v1/workspaces/${fixture.workspace.id}/projects`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Forbidden", slug: "forbidden" }),
      },
    ),
  });

  expect(response.status).toBe(403);
  expect(fixture.projectCreates).toHaveLength(0);
});
