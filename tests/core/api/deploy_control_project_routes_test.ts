import { expect, test } from "bun:test";

import { createTakosumiService } from "../../../core/bootstrap.ts";

const TOKEN = "project-route-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function service() {
  return await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
}

async function createWorkspace(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  handle: string,
): Promise<string> {
  const response = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle,
      displayName: handle,
      type: "personal",
      ownerUserId: `account_${handle}`,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).workspace.id as string;
}

test("Project routes expose the durable default and explicit Workspace Projects", async () => {
  const { app } = await service();
  const workspaceId = await createWorkspace(app, "project-owner");

  const initial = await app.request(
    `/internal/v1/workspaces/${workspaceId}/projects`,
    { headers: headers() },
  );
  expect(initial.status).toBe(200);
  const initialProjects = (await initial.json()).projects as Array<{
    id: string;
    workspaceId: string;
    slug: string;
  }>;
  expect(initialProjects).toHaveLength(1);
  expect(initialProjects[0]).toMatchObject({
    id: `prj_default_${workspaceId}`,
    workspaceId,
    slug: "default",
  });

  const created = await app.request(
    `/internal/v1/workspaces/${workspaceId}/projects`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "Production services",
        slug: "production-services",
        projectJson: { color: "teal" },
      }),
    },
  );
  expect(created.status).toBe(201);
  const project = (await created.json()).project as {
    id: string;
    workspaceId: string;
    slug: string;
    projectJson: Record<string, unknown>;
  };
  expect(project).toMatchObject({
    workspaceId,
    slug: "production-services",
    projectJson: { color: "teal" },
  });

  const read = await app.request(`/internal/v1/projects/${project.id}`, {
    headers: headers(),
  });
  expect(read.status).toBe(200);
  expect((await read.json()).project).toEqual(project);

  const listed = await app.request(
    `/internal/v1/workspaces/${workspaceId}/projects`,
    { headers: headers() },
  );
  expect(listed.status).toBe(200);
  expect(
    ((await listed.json()).projects as Array<{ id: string }>).map(
      (item) => item.id,
    ),
  ).toContain(project.id);
});

test("Project routes reject duplicate slugs, unknown Workspaces, and executable-shaped extra fields", async () => {
  const { app } = await service();
  const workspaceId = await createWorkspace(app, "project-validation");
  const body = { name: "Web", slug: "web" };

  const first = await app.request(
    `/internal/v1/workspaces/${workspaceId}/projects`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
  );
  expect(first.status).toBe(201);

  const duplicate = await app.request(
    `/internal/v1/workspaces/${workspaceId}/projects`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
  );
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error.code).toBe("failed_precondition");

  const unknownWorkspace = await app.request(
    "/internal/v1/workspaces/ws_missing/projects",
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
  );
  expect(unknownWorkspace.status).toBe(404);

  const executableMetadata = await app.request(
    `/internal/v1/workspaces/${workspaceId}/projects`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        ...body,
        modulePath: "./infra",
      }),
    },
  );
  expect(executableMetadata.status).toBe(400);
  expect((await executableMetadata.json()).error.message).toContain(
    "unknown_field",
  );
});
