import { expect, test } from "bun:test";

import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT,
  OPERATOR_CONTROL_MCP_MODULE_INTERFACE_SPEC,
  OPERATOR_CONTROL_MCP_PATH,
  OPERATOR_CONTROL_MCP_TOOLS,
  operatorControlMcpResource,
  operatorControlMcpResourceAuthorized,
  type OperatorControlMcpAuthority,
} from "../../../deploy/operator-control-mcp.ts";
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
  const authority: OperatorControlMcpAuthority = {
    workspaceId: "workspace_a",
    dispatchPublicControl: async () => Response.json({}),
    installPlanWorkspaceId: async () => "workspace_a",
    capsuleWorkspaceId: async () => "workspace_a",
    runWorkspaceId: async () => "workspace_a",
  };
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
  expect((await second?.json()).result.tools).toHaveLength(8);
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
  const createAuthority = async (): Promise<OperatorControlMcpAuthority> => ({
    workspaceId: "workspace_a",
    capsuleWorkspaceId: async () => undefined,
    runWorkspaceId: async () => undefined,
    installPlanWorkspaceId: async (installPlanId) => {
      installPlanLookups.push(installPlanId);
      return "workspace_a";
    },
    dispatchPublicControl: async (controlRequest) => {
      dispatched.push(controlRequest);
      expect(controlRequest.headers.get("authorization")).toBeNull();
      return Response.json({ nextAction: "reconcile" }, { status: 201 });
    },
  });

  const created = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_install_plan_create",
      arguments: {
        idempotencyKey: "agent-run-1:yurucommu",
        source: {
          name: "yurucommu-source",
          url: "https://github.com/tako0614/yurucommu.git",
          ref: "main",
          path: ".",
        },
        capsule: { name: "yurucommu", environment: "production" },
        options: { deploymentProfileKey: "takoserver" },
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
  expect(new URL(dispatched[0]!.url).pathname).toBe(
    "/api/v1/workspaces/workspace_a/install-plans",
  );
  expect(dispatched[0]!.headers.get("idempotency-key")).toBe(
    "agent-run-1:yurucommu",
  );
  expect(await dispatched[0]!.json()).toEqual({
    source: {
      name: "yurucommu-source",
      url: "https://github.com/tako0614/yurucommu.git",
      ref: "main",
      path: ".",
    },
    capsule: { name: "yurucommu", environment: "production" },
    options: { deploymentProfileKey: "takoserver" },
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

test("install-plan reads and reconciliation are fenced to the bound Workspace", async () => {
  let dispatched = false;
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_install_plan_get",
      arguments: { installPlanId: "gip_other_workspace" },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async () => ({
        workspaceId: "workspace_a",
        capsuleWorkspaceId: async () => undefined,
        runWorkspaceId: async () => undefined,
        installPlanWorkspaceId: async () => "workspace_b",
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
});

test("install-plan tools reject unstable idempotency keys and undeclared variable payloads before dispatch", async () => {
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
  ]) {
    const response = await handlePlatformOperatorControlMcpRequest(
      request("tools/call", {
        name: "takosumi_install_plan_create",
        arguments: arguments_,
      }),
      env(),
      {
        verifySession: async () => interfaceSession(),
        createAuthority: async () => ({
          workspaceId: "workspace_a",
          installPlanWorkspaceId: async () => undefined,
          capsuleWorkspaceId: async () => undefined,
          runWorkspaceId: async () => undefined,
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

test("Interface OAuth subject and Workspace are forwarded to the public control authority without a broad token", async () => {
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
        expect(session.workspaceId).toBe("workspace_a");
        expect(session.interfaceBindingId).toBe("binding_control");
        expect(session.interfaceResolvedRevision).toBe(7);
        return {
          workspaceId: session.workspaceId,
          installPlanWorkspaceId: async () => undefined,
          capsuleWorkspaceId: async (capsuleId) => {
            targetLookups.push(capsuleId);
            return "workspace_a";
          },
          runWorkspaceId: async () => undefined,
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

  expect(targetLookups).toEqual(["capsule_target"]);
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

test("tool targets are fenced to the introspected Binding Workspace before public dispatch", async () => {
  let dispatched = false;
  const response = await handlePlatformOperatorControlMcpRequest(
    request("tools/call", {
      name: "takosumi_run_apply",
      arguments: { runId: "run_other_workspace" },
    }),
    env(),
    {
      verifySession: async () => interfaceSession(),
      createAuthority: async () => ({
        workspaceId: "workspace_a",
        installPlanWorkspaceId: async () => undefined,
        capsuleWorkspaceId: async () => undefined,
        runWorkspaceId: async () => "workspace_b",
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
});

test("non-Interface, wrong-audience, and stale-scope sessions fail closed", async () => {
  for (const session of [
    interfaceSession({ authKind: "personal-access-token" }),
    interfaceSession({ audience: `${ORIGIN}/mcp/other` }),
    interfaceSession({ scopes: ["admin"] }),
    interfaceSession({ interfaceResolvedRevision: undefined }),
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
