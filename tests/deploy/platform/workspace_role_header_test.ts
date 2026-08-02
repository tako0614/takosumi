import { expect, test } from "bun:test";
import { handlePlatformExtensionRouteRequest } from "../../../deploy/platform/worker.ts";

const workspaceRoles = ["owner", "admin", "member", "viewer"] as const;

test("platform extension strips forged Workspace role and propagates verified session and PAT roles", async () => {
  for (const authKind of ["session", "personal-access-token"] as const) {
    for (const workspaceRole of workspaceRoles) {
      let forwarded: Record<string, string | null> | undefined;
      const checked: string[] = [];
      const response = await handlePlatformExtensionRouteRequest(
        new Request(
          "https://app.takosumi.com/extensions/role?workspaceId=space_same",
          {
            headers: {
              authorization: "Bearer raw-token",
              cookie: "takosumi_session=raw-cookie",
              "x-takosumi-platform-authenticated": "1",
              "x-takosumi-platform-subject": "spoofed-subject",
              "x-takosumi-platform-workspace-id": "space_attacker",
              "x-takosumi-platform-workspace-role": "owner",
            },
          },
        ),
        {
          ROLE_EXTENSION: {
            fetch: async (request: Request) => {
              forwarded = {
                authorization: request.headers.get("authorization"),
                cookie: request.headers.get("cookie"),
                authenticated: request.headers.get(
                  "x-takosumi-platform-authenticated",
                ),
                subject: request.headers.get("x-takosumi-platform-subject"),
                workspaceId: request.headers.get(
                  "x-takosumi-platform-workspace-id",
                ),
                workspaceRole: request.headers.get(
                  "x-takosumi-platform-workspace-role",
                ),
              };
              return Response.json({ ok: true });
            },
          },
        } as never,
        {
          basePath: "/extensions/role",
          handlerKey: "ROLE_EXTENSION",
          workspaceContext: "query-required",
        },
        async () => ({
          authenticated: true,
          authKind,
          subject: "verified-subject",
          scopes: ["role.read"],
        }),
        undefined,
        async (_request, _env, workspaceId) => {
          checked.push(workspaceId);
          return workspaceRole;
        },
      );

      expect(response.status).toBe(200);
      expect(checked).toEqual(["space_same"]);
      expect(forwarded).toEqual({
        authorization: null,
        cookie: null,
        authenticated: "1",
        subject: "verified-subject",
        workspaceId: "space_same",
        workspaceRole,
      });
    }
  }
});

test("platform extension keeps Workspace role absent without verified Workspace context", async () => {
  let forwarded: Record<string, string | null> | undefined;
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/role", {
      headers: {
        "x-takosumi-platform-workspace-role": "owner",
      },
    }),
    {
      ROLE_EXTENSION: {
        fetch: async (request: Request) => {
          forwarded = {
            authenticated: request.headers.get(
              "x-takosumi-platform-authenticated",
            ),
            subject: request.headers.get("x-takosumi-platform-subject"),
            workspaceId: request.headers.get(
              "x-takosumi-platform-workspace-id",
            ),
            workspaceRole: request.headers.get(
              "x-takosumi-platform-workspace-role",
            ),
          };
          return Response.json({ ok: true });
        },
      },
    } as never,
    { basePath: "/extensions/role", handlerKey: "ROLE_EXTENSION" },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "verified-subject",
      workspaceId: "space_same",
      workspaceRole: "member",
    }),
  );

  expect(response.status).toBe(200);
  expect(forwarded).toEqual({
    authenticated: "1",
    subject: "verified-subject",
    workspaceId: "space_same",
    workspaceRole: null,
  });
});

test("platform extension denies cross-Workspace context before dispatch", async () => {
  let forwarded = false;
  let checked = false;
  const response = await handlePlatformExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/extensions/role?workspaceId=space_other",
      {
        headers: {
          "x-takosumi-platform-workspace-role": "owner",
        },
      },
    ),
    {
      ROLE_EXTENSION: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ ok: true });
        },
      },
    } as never,
    {
      basePath: "/extensions/role",
      handlerKey: "ROLE_EXTENSION",
      workspaceContext: "query-required",
    },
    async () => ({
      authenticated: true,
      authKind: "personal-access-token",
      subject: "verified-subject",
      workspaceId: "space_same",
      workspaceRole: "member",
    }),
    undefined,
    async () => {
      checked = true;
      return "member";
    },
  );

  expect(response.status).toBe(403);
  expect(forwarded).toBe(false);
  expect(checked).toBe(false);
});

test("platform extension denies an unknown verified Workspace role", async () => {
  const response = await handlePlatformExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/extensions/role?workspaceId=space_same",
    ),
    {
      ROLE_EXTENSION: {
        fetch: async () => Response.json({ ok: true }),
      },
    } as never,
    {
      basePath: "/extensions/role",
      handlerKey: "ROLE_EXTENSION",
      workspaceContext: "query-required",
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "verified-subject",
      workspaceRole: "unknown" as never,
    }),
    undefined,
    async () => true,
  );

  expect(response.status).toBe(403);
});
