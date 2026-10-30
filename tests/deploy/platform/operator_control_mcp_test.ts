import { expect, test } from "bun:test";

import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT,
  OPERATOR_CONTROL_MCP_MODULE_INTERFACE_SPEC,
  OPERATOR_CONTROL_MCP_PATH,
  OPERATOR_CONTROL_MCP_TOOLS,
  operatorControlMcpResource,
  operatorControlMcpResourceAuthorized,
  type OperatorControlMcpAppFacts,
  type OperatorControlMcpAuthority,
} from "../../../deploy/operator-control-mcp.ts";
import { createOperatorControlMcpAuthority } from "../../../deploy/platform/operator-control-mcp-authority.ts";
import { deterministicInitialCapsuleId } from "../../../core/domains/install-plans/source-reservation.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/errors.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import {
  handlePlatformOperatorControlMcpRequest,
  type CloudflareWorkerEnv,
  type PlatformExtensionSessionContext,
  verifyPlatformExtensionBearerToken,
} from "../../../deploy/platform/worker.ts";

const ORIGIN = "https://app.takosumi.test";
const RESOURCE = operatorControlMcpResource(ORIGIN);

function request(method: string, params?: unknown): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      authorization: "Bearer invocation-only-interface-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

function interfaceSession(
  overrides: Partial<PlatformExtensionSessionContext> = {},
): PlatformExtensionSessionContext {
  return {
    authenticated: true,
    authKind: "interface-oauth-token",
    subject: "principal_a",
    workspaceId: "workspace_a",
    capsuleId: "capsule_adapter",
    audience: RESOURCE,
    interfaceId: "interface_control",
    interfaceBindingId: "binding_control",
    interfaceResolvedRevision: 7,
    scopes: ["mcp.invoke"],
    ...overrides,
  };
}

function env(enabled = true): CloudflareWorkerEnv {
  return {
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: enabled ? "1" : "0",
    TAKOSUMI_ACCOUNTS_ISSUER: ORIGIN,
  } as never;
}

/**
 * The MCP's own app (`capsule_adapter`) and a target app both owned by the
 * token's subject in the token's Workspace, unless a test overrides them.
 */
function authorityFor(
  overrides: Partial<OperatorControlMcpAuthority> & {
    readonly apps?: Readonly<Record<string, OperatorControlMcpAppFacts>>;
  } = {},
): OperatorControlMcpAuthority {
  const { apps: appOverrides, ...rest } = overrides;
  const apps: Record<string, OperatorControlMcpAppFacts> = {
    capsule_adapter: { ownerAccountId: "principal_a", workspaceId: "workspace_a" },
    capsule_target: { ownerAccountId: "principal_a", workspaceId: "workspace_a" },
    ...appOverrides,
  };
  return {
    subject: "principal_a",
    capsuleId: "capsule_adapter",
    workspaceId: "workspace_a",
    dispatchPublicControl: async () => Response.json({}),
    app: async (capsuleId) => apps[capsuleId],
    installPlan: async () => undefined,
    run: async () => undefined,
    installNamespaceId: async () => "workspace_a",
    appPartitions: async (capsuleIds) =>
      new Map(capsuleIds.flatMap((id) => apps[id] ? [[id, apps[id]!.workspaceId] as const] : [])),
    ...rest,
  };
}

test("operator control MCP is absent until explicitly enabled", async () => {
  let verified = false;
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/list"),
    env(false),
    {
      verifySession: async () => {
        verified = true;
        return interfaceSession();
      },
    },
  );

  expect(response?.status).toBe(404);
  expect(verified).toBe(false);
});

test("every MCP POST re-introspects exact Interface OAuth evidence and serves adapter-owned annotations", async () => {
  let verifications = 0;
  const verifySession = async (
    incoming: Request,
    _env: CloudflareWorkerEnv,
    route?: {
      readonly basePath: string;
      readonly requiredScopes?: readonly string[];
    },
  ) => {
    verifications += 1;
    expect(incoming.headers.get("authorization")).toBe(
      "Bearer invocation-only-interface-token",
    );
    expect(route?.basePath).toBe(OPERATOR_CONTROL_MCP_PATH);
    expect(route?.requiredScopes).toEqual(["mcp.invoke"]);
    return interfaceSession();
  };
  const authority = authorityFor();
  const createAuthority = async () => authority;

  const first = await handlePlatformOperatorControlMcpRequest(
    request("tools/list"),
    env(),
    { verifySession, createAuthority },
  );
  const second = await handlePlatformOperatorControlMcpRequest(
    request("tools/list"),
    env(),
    { verifySession, createAuthority },
  );

  expect(verifications).toBe(2);
  expect(first?.headers.get("cache-control")).toBe("no-store");
  expect((await first?.json()).result.tools).toEqual(
    OPERATOR_CONTROL_MCP_TOOLS,
  );
  expect((await second?.json()).result.tools).toHaveLength(9);
  expect(
    OPERATOR_CONTROL_MCP_TOOLS.find(
      (tool) => tool.name === "takosumi_install_plan_create",
    )?.inputSchema,
  ).toMatchObject({
    properties: {
      options: {
        properties: {
          modulePath: { type: "string", minLength: 1, maxLength: 1024 },
          providerBindings: {
            type: "array",
            maxItems: 32,
            items: {
              required: ["provider", "moduleLocalName", "connectionId"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  });
  expect(
    OPERATOR_CONTROL_MCP_TOOLS.find(
      (tool) => tool.name === "takosumi_capsules_list",
    )?.annotations,
  ).toEqual({ readOnlyHint: true, destructiveHint: false });
  expect(
    OPERATOR_CONTROL_MCP_TOOLS.find(
      (tool) => tool.name === "takosumi_capsule_plan",
    )?.annotations,
  ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  for (const name of [
    "takosumi_install_plan_create",
    "takosumi_install_plan_reconcile",
    "takosumi_capsule_destroy_plan",
  ]) {
    expect(
      OPERATOR_CONTROL_MCP_TOOLS.find((tool) => tool.name === name)
        ?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  }
  for (const name of ["takosumi_run_approve", "takosumi_run_apply"]) {
    expect(
      OPERATOR_CONTROL_MCP_TOOLS.find((tool) => tool.name === name)
        ?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  }
});

test("Git install-plan tools forward only the bounded public API contract and preserve idempotency", async () => {
  const dispatched: Request[] = [];
  const installPlanLookups: string[] = [];
  const createAuthority = async (): Promise<OperatorControlMcpAuthority> => authorityFor({
    installPlan: async (installPlanId) => {
      installPlanLookups.push(installPlanId);
      return {
        workspaceId: "workspace_a",
        createdBy: "principal_a",
        actorSubject: "principal_a",
      };
    },
    dispatchPublicControl: async (controlRequest) => {
      dispatched.push(controlRequest);
      expect(controlRequest.headers.get("authorization")).toBeNull();
      return Response.json({
        installPlan: { id: "gip_12345678", workspaceId: "workspace_a" },
        nextAction: "reconcile",
      }, { status: 201 });
    },
  });

  const created = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_install_plan_create",
      arguments: {
        idempotencyKey: "agent-run-1:sample-app",
        source: {
          name: "sample-app-source",
          url: "https://git.example.test/apps/sample-app.git",
          ref: "main",
          path: ".",
        },
        capsule: { name: "sample-app", environment: "production" },
        options: {
          modulePath: ".",
          providerBindings: [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
              connectionId: "conn_cloudflare_default",
            },
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
              childAlias: "account",
              connectionId: "conn_cloudflare_account",
            },
          ],
        },
      },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority,
    },
  );
  expect((await created?.json()).result.isError).toBe(false);
  expect(dispatched).toHaveLength(1);
  // The Workspace-free install route: the new app is the MCP owner's.
  expect(new URL(dispatched[0]!.url).pathname).toBe("/api/v1/install-plans");
  expect(dispatched[0]!.headers.get("idempotency-key")).toBe(
    "agent-run-1:sample-app",
  );
  expect(await dispatched[0]!.json()).toEqual({
    source: {
      name: "sample-app-source",
      url: "https://git.example.test/apps/sample-app.git",
      ref: "main",
      path: ".",
    },
    capsule: { name: "sample-app", environment: "production" },
    options: {
      modulePath: ".",
      providerBindings: [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "cloudflare",
          connectionId: "conn_cloudflare_default",
        },
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "cloudflare",
          childAlias: "account",
          connectionId: "conn_cloudflare_account",
        },
      ],
    },
  });

  const reconciled = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_install_plan_reconcile",
      arguments: { installPlanId: "gip_12345678" },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority,
    },
  );
  expect((await reconciled?.json()).result.isError).toBe(false);
  expect(installPlanLookups).toEqual(["gip_12345678"]);
  expect(new URL(dispatched[1]!.url).pathname).toBe(
    "/api/v1/install-plans/gip_12345678/reconcile",
  );
});

test("install-plan reads and reconciliation reach only the MCP owner's installs inside the token's Workspace", async () => {
  for (const plan of [
    // The owner's own pre-app install, but outside the token's Workspace.
    { workspaceId: "workspace_b", createdBy: "principal_a", actorSubject: "principal_a" },
    // Someone else's pre-app install in the same Workspace.
    { workspaceId: "workspace_a", createdBy: "principal_b", actorSubject: "principal_b" },
    // An install whose app belongs to another account.
    { capsuleId: "capsule_other_owner", workspaceId: "workspace_a", createdBy: "principal_a", actorSubject: "principal_a" },
  ]) {
    let dispatched = false;
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", {
        name: "takosumi_install_plan_get",
        arguments: { installPlanId: "gip_other" },
      }),
      env(),
      {
        verifySession: async () => interfaceSession(),
        createAuthority: async () => authorityFor({
          apps: { capsule_other_owner: { ownerAccountId: "principal_b", workspaceId: "workspace_a" } },
          installPlan: async () => plan,
          dispatchPublicControl: async () => {
            dispatched = true;
            return Response.json({});
          },
        }),
      },
    );

    expect(dispatched).toBe(false);
    expect((await response?.json()).result).toMatchObject({
      isError: true,
      structuredContent: { status: 403 },
    });
  }
});

test("install-plan tools reject unstable keys and retired or ambiguous option shapes before dispatch", async () => {
  let dispatched = false;
  for (const arguments_ of [
    {
      idempotencyKey: " leading-space",
      source: { name: "source", url: "https://example.com/repo.git" },
      capsule: { name: "capsule", environment: "production" },
    },
    {
      idempotencyKey: "agent-run-1",
      source: { name: "source", url: "https://example.com/repo.git" },
      capsule: { name: "capsule", environment: "production" },
      variables: { token: "must-not-cross" },
    },
    {
      idempotencyKey: "agent-run-2",
      source: { name: "source", url: "https://example.com/repo.git" },
      capsule: { name: "capsule", environment: "production" },
      options: {
        providerBindingConnectionIds: {
          "registry.opentofu.org/cloudflare/cloudflare": "conn_old_map",
        },
      },
    },
    {
      idempotencyKey: "agent-run-3",
      source: { name: "source", url: "https://example.com/repo.git" },
      capsule: { name: "capsule", environment: "production" },
      options: { deploymentProfileKey: "retired-profile" },
    },
    {
      idempotencyKey: "agent-run-4",
      source: { name: "source", url: "https://example.com/repo.git" },
      capsule: { name: "capsule", environment: "production" },
      options: {
        providerBindings: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            moduleLocalName: "cloudflare",
            connectionId: "conn_a",
          },
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            moduleLocalName: "cloudflare",
            connectionId: "conn_b",
          },
        ],
      },
    },
  ]) {
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", {
        name: "takosumi_install_plan_create",
        arguments: arguments_,
      }),
      env(),
      {
        verifySession: async () => interfaceSession(),
        createAuthority: async () => authorityFor({
          dispatchPublicControl: async () => {
            dispatched = true;
            return Response.json({});
          },
        }),
      },
    );
    expect((await response?.json()).result).toMatchObject({
      isError: true,
      structuredContent: { status: 403 },
    });
  }
  expect(dispatched).toBe(false);
});

test("Interface OAuth subject, app and Workspace are forwarded to the public control authority without a broad token", async () => {
  const dispatched: Request[] = [];
  const targetLookups: string[] = [];
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_capsule_plan",
      arguments: {
        capsuleId: "capsule_target",
        runnerProfileId: "opentofu-default",
      },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async (session) => {
        expect(session.subject).toBe("principal_a");
        expect(session.capsuleId).toBe("capsule_adapter");
        expect(session.workspaceId).toBe("workspace_a");
        expect(session.interfaceBindingId).toBe("binding_control");
        expect(session.interfaceResolvedRevision).toBe(7);
        const base = authorityFor();
        return {
          ...base,
          app: async (capsuleId) => {
            targetLookups.push(capsuleId);
            return await base.app(capsuleId);
          },
          dispatchPublicControl: async (controlRequest) => {
            dispatched.push(controlRequest);
            // The Interface bearer must never cross into the public handler.
            expect(controlRequest.headers.get("authorization")).toBeNull();
            return Response.json(
              { run: { id: "run_plan", workspaceId: "workspace_a" } },
              { status: 201 },
            );
          },
        };
      },
    },
  );

  // The MCP's own app first (its owner acts), then the target.
  expect(targetLookups).toEqual(["capsule_adapter", "capsule_target"]);
  expect(dispatched).toHaveLength(1);
  expect(new URL(dispatched[0]!.url).pathname).toBe(
    "/api/v1/capsules/capsule_target/plan",
  );
  expect(await dispatched[0]!.json()).toEqual({
    runnerProfileId: "opentofu-default",
  });
  const result = await response?.json();
  expect(result.result.isError).toBe(false);
  expect(result.result.structuredContent.status).toBe(201);
});

test("Capsule destroy-plan tool stops at a reviewable Run without approving or applying", async () => {
  const dispatched: Request[] = [];
  const capsuleLookups: string[] = [];
  const base = authorityFor();
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_capsule_destroy_plan",
      arguments: { capsuleId: "capsule_target" },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async () => ({
        ...base,
        app: async (capsuleId) => {
          capsuleLookups.push(capsuleId);
          return await base.app(capsuleId);
        },
        dispatchPublicControl: async (controlRequest) => {
          dispatched.push(controlRequest);
          return Response.json(
            {
              run: {
                id: "run_destroy_plan",
                workspaceId: "workspace_a",
                capsuleId: "capsule_target",
                type: "destroy_plan",
                status: "waiting_approval",
              },
            },
            { status: 201 },
          );
        },
      }),
    },
  );

  expect(capsuleLookups).toEqual(["capsule_adapter", "capsule_target"]);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.method).toBe("POST");
  expect(new URL(dispatched[0]!.url).pathname).toBe(
    "/api/v1/capsules/capsule_target/destroy-plan",
  );
  expect(await dispatched[0]!.json()).toEqual({});
  expect((await response?.json()).result).toMatchObject({
    isError: false,
    structuredContent: {
      status: 201,
      body: {
        run: { type: "destroy_plan", status: "waiting_approval" },
      },
    },
  });
});

test("Run targets are fenced to the MCP owner's apps inside the token's Workspace before public dispatch", async () => {
  for (const run of [
    { capsuleId: "capsule_other_workspace" },
    { capsuleId: "capsule_other_owner" },
    { capsuleId: "capsule_unowned" },
    {},
    undefined,
  ]) {
    let dispatched = false;
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", {
        name: "takosumi_run_apply",
        arguments: { runId: "run_target" },
      }),
      env(),
      {
        verifySession: async () => interfaceSession(),
        createAuthority: async () => authorityFor({
          apps: {
            capsule_other_workspace: { ownerAccountId: "principal_a", workspaceId: "workspace_b" },
            capsule_other_owner: { ownerAccountId: "principal_b", workspaceId: "workspace_a" },
            capsule_unowned: { workspaceId: "workspace_a" },
          },
          run: async () => run,
          dispatchPublicControl: async () => {
            dispatched = true;
            return Response.json({});
          },
        }),
      },
    );

    expect(dispatched).toBe(false);
    expect((await response?.json()).result).toMatchObject({
      isError: true,
      structuredContent: { status: 403 },
    });
  }
});

test("the MCP acts only while the token's subject owns the MCP's own app", async () => {
  const tools = [
    { name: "takosumi_capsules_list", arguments: {} },
    { name: "takosumi_capsule_plan", arguments: { capsuleId: "capsule_target" } },
    { name: "takosumi_run_get", arguments: { runId: "run_target" } },
    {
      name: "takosumi_install_plan_create",
      arguments: {
        idempotencyKey: "agent-run-1",
        source: { name: "source", url: "https://example.com/repo.git" },
        capsule: { name: "capsule", environment: "production" },
      },
    },
  ];
  for (const own of [
    // Transferred to someone else: the binding subject no longer acts.
    { ownerAccountId: "principal_b", workspaceId: "workspace_a" },
    // No ownership row: there is no owner to act for.
    { workspaceId: "workspace_a" },
    // A token whose Workspace is not the MCP app's own.
    { ownerAccountId: "principal_a", workspaceId: "workspace_b" },
    undefined,
  ]) {
    for (const tool of tools) {
      let dispatched = false;
      const response = await handlePlatformOperatorControlMcpRequest(
        request("tools/call", tool),
        env(),
        {
          verifySession: async () => interfaceSession(),
          createAuthority: async () => ({
            ...authorityFor({ run: async () => ({ capsuleId: "capsule_target" }) }),
            app: async (capsuleId) =>
              capsuleId === "capsule_adapter"
                ? own
                : { ownerAccountId: "principal_a", workspaceId: "workspace_a" },
            dispatchPublicControl: async () => {
              dispatched = true;
              return Response.json({ apps: [] });
            },
          }),
        },
      );
      expect(dispatched).toBe(false);
      expect((await response?.json()).result).toMatchObject({
        isError: true,
        structuredContent: { status: 403 },
      });
    }
  }
});

test("the app list reads /api/v1/apps and keeps only the owner's own apps inside the token's Workspace", async () => {
  const dispatched: Request[] = [];
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_capsules_list",
      arguments: { cursor: "page_2" },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async () => authorityFor({
        apps: {
          capsule_elsewhere: { ownerAccountId: "principal_a", workspaceId: "workspace_b" },
          capsule_shared_with_me: { ownerAccountId: "principal_b", workspaceId: "workspace_a" },
        },
        dispatchPublicControl: async (controlRequest) => {
          dispatched.push(controlRequest);
          return Response.json({
            apps: [
              { capsuleId: "capsule_target", name: "target", role: "owner" },
              { capsuleId: "capsule_elsewhere", name: "elsewhere", role: "owner" },
              { capsuleId: "capsule_shared_with_me", name: "shared", role: "member" },
              { capsuleId: "capsule_unknown", name: "unknown", role: "owner" },
            ],
            nextCursor: "page_3",
          });
        },
      }),
    },
  );

  expect(dispatched).toHaveLength(1);
  const url = new URL(dispatched[0]!.url);
  expect(url.pathname).toBe("/api/v1/apps");
  expect(url.searchParams.get("cursor")).toBe("page_2");
  expect((await response?.json()).result.structuredContent).toEqual({
    status: 200,
    body: {
      apps: [{ capsuleId: "capsule_target", name: "target", role: "owner" }],
      nextCursor: "page_3",
    },
  });

  // A malformed cursor is refused before anything is read.
  let dispatchedMalformed = false;
  const malformed = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_capsules_list",
      arguments: { cursor: "../workspaces" },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async () => authorityFor({
        dispatchPublicControl: async () => {
          dispatchedMalformed = true;
          return Response.json({ apps: [] });
        },
      }),
    },
  );
  expect(dispatchedMalformed).toBe(false);
  expect((await malformed?.json()).result.structuredContent.status).toBe(403);
});

test("a Workspace-bound token installs only when the new app stays inside its Workspace", async () => {
  let dispatched = false;
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_install_plan_create",
      arguments: {
        idempotencyKey: "agent-run-1",
        source: { name: "source", url: "https://example.com/repo.git" },
        capsule: { name: "capsule", environment: "production" },
      },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async () => authorityFor({
        installNamespaceId: async () => "workspace_personal_elsewhere",
        dispatchPublicControl: async () => {
          dispatched = true;
          return Response.json({});
        },
      }),
    },
  );
  expect(dispatched).toBe(false);
  expect((await response?.json()).result.structuredContent.status).toBe(403);
});

test("Capsule evidence without a Workspace acts on the owner's apps with no Workspace restriction", async () => {
  const dispatched: string[] = [];
  const sessions: unknown[] = [];
  for (const tool of [
    { name: "takosumi_capsule_plan", arguments: { capsuleId: "capsule_elsewhere" } },
    {
      name: "takosumi_install_plan_create",
      arguments: {
        idempotencyKey: "agent-run-1",
        source: { name: "source", url: "https://example.com/repo.git" },
        capsule: { name: "capsule", environment: "production" },
      },
    },
  ]) {
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", tool),
      env(),
      {
        verifySession: async () => interfaceSession({ workspaceId: undefined }),
        createAuthority: async (session) => {
          sessions.push(session.workspaceId);
          const { workspaceId: _workspaceId, ...base } = authorityFor({
            apps: {
              capsule_elsewhere: { ownerAccountId: "principal_a", workspaceId: "workspace_b" },
            },
            installNamespaceId: async () => {
              throw new Error("a token without a Workspace has no namespace restriction");
            },
          });
          return {
            ...base,
            dispatchPublicControl: async (controlRequest) => {
              dispatched.push(new URL(controlRequest.url).pathname);
              return Response.json({}, { status: 201 });
            },
          };
        },
      },
    );
    expect((await response?.json()).result.isError).toBe(false);
  }
  expect(sessions).toEqual([undefined, undefined]);
  expect(dispatched).toEqual([
    "/api/v1/capsules/capsule_elsewhere/plan",
    "/api/v1/install-plans",
  ]);
});

test("non-Interface, wrong-audience, and stale-scope sessions fail closed", async () => {
  for (const session of [
    interfaceSession({ authKind: "personal-access-token" }),
    interfaceSession({ audience: `${ORIGIN}/mcp/other` }),
    interfaceSession({ scopes: ["admin"] }),
    interfaceSession({ interfaceResolvedRevision: undefined }),
    // The MCP's own app is required; a Workspace alone never identifies it.
    interfaceSession({ capsuleId: undefined }),
    interfaceSession({ workspaceId: "workspace a" }),
  ]) {
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/list"),
      env(),
      { verifySession: async () => session },
    );
    expect(response?.status).toBe(401);
  }
});

test("local TLS termination introspects and verifies the canonical HTTPS MCP audience", async () => {
  const resources: string[] = [];
  const localEnv = {
    ...env(),
    LOCAL_SUBSTRATE_TEST_BED: "1",
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "local-platform-client",
    TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "local-platform-secret",
  } as CloudflareWorkerEnv;
  const session = await verifyPlatformExtensionBearerToken(
    new Request(`http://app.takosumi.test${OPERATOR_CONTROL_MCP_PATH}`, {
      method: "POST",
    }),
    localEnv,
    "invocation-only-interface-token",
    {
      id: "operator-control-mcp.v1",
      basePath: OPERATOR_CONTROL_MCP_PATH,
      handlerKey: "builtin:operator-control-mcp.v1",
      authMode: "platform",
      requiredScopes: ["mcp.invoke"],
      capabilities: ["mcp.operator-control.v1"],
    },
    async (introspectionRequest) => {
      const body = new URLSearchParams(await introspectionRequest.text());
      resources.push(body.get("resource") ?? "");
      return Response.json({
        active: true,
        token_use: "interface_oauth",
        scope: "mcp.invoke",
        sub: "principal_a",
        aud: RESOURCE,
        takosumi: {
          workspace_id: "workspace_a",
          capsule_id: "capsule_adapter",
          interface_id: "interface_control",
          interface_binding_id: "binding_control",
          interface_resolved_revision: 7,
        },
      });
    },
  );

  expect(resources).toEqual([RESOURCE]);
  expect(session).toEqual(interfaceSession());
});

test("Interface OAuth introspection passes with Capsule evidence alone and fails with neither owner", async () => {
  const route = {
    id: "operator-control-mcp.v1",
    basePath: OPERATOR_CONTROL_MCP_PATH,
    handlerKey: "builtin:operator-control-mcp.v1",
    authMode: "platform" as const,
    requiredScopes: ["mcp.invoke"],
    capabilities: ["mcp.operator-control.v1"],
  };
  const introspected = (takosumi: Record<string, unknown>) =>
    verifyPlatformExtensionBearerToken(
      new Request(RESOURCE, { method: "POST" }),
      {
        ...env(),
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "platform-client",
        TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "platform-secret",
      } as CloudflareWorkerEnv,
      "invocation-only-interface-token",
      route,
      async () =>
        Response.json({
          active: true,
          token_use: "interface_oauth",
          scope: "mcp.invoke",
          sub: "principal_a",
          aud: RESOURCE,
          takosumi: {
            interface_id: "interface_control",
            interface_binding_id: "binding_control",
            interface_resolved_revision: 7,
            ...takosumi,
          },
        }),
    );

  expect(await introspected({ capsule_id: "capsule_adapter" })).toEqual(
    interfaceSession({ workspaceId: undefined }),
  );
  // A Workspace-owned Interface keeps its Workspace evidence.
  expect(await introspected({ workspace_id: "workspace_a" })).toEqual(
    interfaceSession({ capsuleId: undefined }),
  );
  for (const evidence of [
    {},
    { capsule_id: "capsule adapter" },
    { workspace_id: "workspace_a", capsule_id: "capsule adapter" },
    { workspace_id: "workspace a", capsule_id: "capsule_adapter" },
  ]) {
    expect(await introspected(evidence)).toEqual({ authenticated: false });
  }
});

test("blueprint owns the ordinary mcp.server spec while the module stays provider-independent", async () => {
  const blueprintSpec = structuredClone(
    OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT.spec,
  );
  const endpoint = blueprintSpec.inputs?.endpoint;
  expect(endpoint?.source).toBe("capsule_output");
  const normalizedBlueprint = {
    ...blueprintSpec,
    inputs: {
      endpoint: {
        ...endpoint,
        capsuleId: "<ambient-capsule-id>",
      },
    },
  };
  expect(normalizedBlueprint).toEqual(
    OPERATOR_CONTROL_MCP_MODULE_INTERFACE_SPEC,
  );
  expect(OPERATOR_CONTROL_MCP_INSTALL_CONFIG.interfaceBlueprints).toEqual([
    OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT,
  ]);
  expect(OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT.bindings?.[0]).toMatchObject({
    subject: { source: "installing_principal" },
    permissions: ["mcp.invoke"],
    delivery: { type: "oauth2" },
  });
  const module = await Bun.file(
    new URL(
      "../../../opentofu-modules/operator-control-mcp/main.tf",
      import.meta.url,
    ),
  ).text();
  expect(module).not.toContain('source = "takosjp/takosumi"');
  expect(module).not.toContain('resource "takosumi_interface"');
  expect(module).not.toContain('resource "takosumi_interface_binding"');
});

test("OAuth resource proof is exact, Capsule-owned, and disabled by default", () => {
  const exact = {
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
    TAKOSUMI_ACCOUNTS_ISSUER: ORIGIN,
  };
  expect(
    operatorControlMcpResourceAuthorized(exact, {
      ownerRef: { kind: "Capsule", id: "capsule_adapter" },
      resource: RESOURCE,
    }),
  ).toBe(true);
  expect(
    operatorControlMcpResourceAuthorized(
      { ...exact, TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "0" },
      {
        ownerRef: { kind: "Capsule", id: "capsule_adapter" },
        resource: RESOURCE,
      },
    ),
  ).toBe(false);
  expect(
    operatorControlMcpResourceAuthorized(exact, {
      ownerRef: { kind: "Workspace", id: "workspace_a" },
      resource: RESOURCE,
    }),
  ).toBe(false);
  expect(
    operatorControlMcpResourceAuthorized(exact, {
      ownerRef: { kind: "Capsule", id: "capsule_adapter" },
      resource: `${ORIGIN}/mcp/other`,
    }),
  ).toBe(false);
});

test("the app list trusts the handler's live owner role and reads partitions in one batch, only for a Workspace-bound token", async () => {
  const listing = {
    apps: [
      { capsuleId: "capsule_target", role: "owner" },
      { capsuleId: "capsule_elsewhere", role: "owner" },
      { capsuleId: "capsule_shared_with_me", role: "member" },
    ],
  };
  for (const workspaceId of ["workspace_a", undefined] as const) {
    const batches: (readonly string[])[] = [];
    let perAppReads = 0;
    const base = authorityFor({
      apps: { capsule_elsewhere: { ownerAccountId: "principal_a", workspaceId: "workspace_b" } },
    });
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", { name: "takosumi_capsules_list", arguments: {} }),
      env(),
      {
        verifySession: async () => interfaceSession(workspaceId ? {} : { workspaceId: undefined }),
        createAuthority: async () => {
          const { workspaceId: _w, ...rest } = base;
          return {
            ...rest,
            ...(workspaceId ? { workspaceId } : {}),
            app: async (capsuleId) => {
              if (capsuleId !== "capsule_adapter") perAppReads += 1;
              return await base.app(capsuleId);
            },
            appPartitions: async (capsuleIds) => {
              batches.push(capsuleIds);
              return await base.appPartitions(capsuleIds);
            },
            dispatchPublicControl: async () => Response.json(listing),
          };
        },
      },
    );
    const ids = ((await response?.json()).result.structuredContent.body.apps as { capsuleId: string }[])
      .map((app) => app.capsuleId);
    expect(perAppReads).toBe(0);
    if (workspaceId) {
      expect(batches).toEqual([["capsule_target", "capsule_elsewhere"]]);
      expect(ids).toEqual(["capsule_target"]);
    } else {
      expect(batches).toEqual([]);
      expect(ids).toEqual(["capsule_target", "capsule_elsewhere"]);
    }
  }
});

test("an idempotent replay from another of the owner's namespaces is not returned to a Workspace-bound token", async () => {
  const replayed = {
    installPlan: { id: "gip_replayed", workspaceId: "workspace_personal_old", createdBy: "principal_a" },
  };
  const create = request("tools/call", {
    name: "takosumi_install_plan_create",
    arguments: {
      idempotencyKey: "agent-run-1",
      source: { name: "source", url: "https://example.com/repo.git" },
      capsule: { name: "capsule", environment: "production" },
    },
  });
  const bound = await handlePlatformOperatorControlMcpRequest(create.clone(), env(), {
    verifySession: async () => interfaceSession(),
    createAuthority: async () => authorityFor({
      dispatchPublicControl: async () => Response.json(replayed, { status: 200 }),
    }),
  });
  const boundResult = (await bound?.json()).result;
  expect(boundResult).toMatchObject({ isError: true, structuredContent: { status: 403 } });
  expect(JSON.stringify(boundResult)).not.toContain("gip_replayed");
  // Inside the restriction, or without one, the replay is returned.
  for (const [session, plan] of [
    [interfaceSession(), { ...replayed.installPlan, workspaceId: "workspace_a" }],
    [interfaceSession({ workspaceId: undefined }), replayed.installPlan],
  ] as const) {
    const response = await handlePlatformOperatorControlMcpRequest(create.clone(), env(), {
      verifySession: async () => session,
      createAuthority: async () => {
        const base = authorityFor({
          dispatchPublicControl: async () => Response.json({ installPlan: plan }, { status: 200 }),
        });
        if (session.workspaceId !== undefined) return base;
        const { workspaceId: _w, ...rest } = base;
        return rest;
      },
    });
    expect((await response?.json()).result.structuredContent).toEqual({
      status: 200,
      body: { installPlan: plan },
    });
  }
});

test("an install plan whose Capsule was committed before the plan recorded it is fenced by that app", async () => {
  const planId = "gip_lost_ack";
  const committed = deterministicInitialCapsuleId(planId);
  const operationsFor = (capsuleOwner: string | undefined) => ({
    gitInstallPlans: {
      get: async (id: string) => id === planId
        ? { id, workspaceId: "workspace_a", createdBy: "principal_a", actorSubject: "principal_a" }
        : undefined,
    },
    capsules: {
      getCapsule: async (capsuleId: string) => {
        if (capsuleId === committed && capsuleOwner !== undefined) {
          return { id: capsuleId, workspaceId: "workspace_a" };
        }
        if (capsuleId === "capsule_adapter") return { id: capsuleId, workspaceId: "workspace_a" };
        throw new OpenTofuControllerError("not_found", "Capsule not found");
      },
      getCapsulesByIds: async () => [],
    },
    appOwnership: {
      getOwnership: async (capsuleId: string) =>
        capsuleId === "capsule_adapter"
          ? { capsuleId, ownerAccountId: "principal_a" }
          : capsuleId === committed && capsuleOwner
            ? { capsuleId, ownerAccountId: capsuleOwner }
            : undefined,
    },
  }) as unknown as ControlPlaneOperations;
  const authorityWith = (capsuleOwner: string | undefined) =>
    createOperatorControlMcpAuthority({
      operations: operationsFor(capsuleOwner),
      store: new InMemoryAccountsStore(),
      session: { subject: "principal_a", capsuleId: "capsule_adapter", workspaceId: "workspace_a" },
      requestUrl: RESOURCE,
    });
  expect((await authorityWith(undefined).installPlan(planId))?.capsuleId).toBeUndefined();
  expect((await authorityWith("principal_a").installPlan(planId))?.capsuleId).toBe(committed);

  for (const [capsuleOwner, expected] of [
    [undefined, 200], // no app yet: the creator's own install
    ["principal_a", 200], // committed app of the owner
    ["principal_b", 403], // committed app now someone else's: the app decides
  ] as const) {
    let dispatched = false;
    const base = authorityWith(capsuleOwner);
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", { name: "takosumi_install_plan_get", arguments: { installPlanId: planId } }),
      env(),
      {
        verifySession: async () => interfaceSession(),
        createAuthority: async () => ({
          ...base,
          dispatchPublicControl: async () => {
            dispatched = true;
            return Response.json({ installPlan: { id: planId } });
          },
        }),
      },
    );
    expect((await response?.json()).result.structuredContent.status).toBe(expected);
    expect(dispatched).toBe(expected === 200);
  }
});
