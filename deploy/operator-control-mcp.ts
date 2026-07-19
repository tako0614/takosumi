import type {
  CapsuleInterfaceBlueprint,
  InterfaceSpec,
} from "takosumi-contract/interfaces";
import {
  MCP_SERVER_INTERFACE_TYPE,
  MCP_SERVER_INTERFACE_VERSION,
  MCP_SERVER_INVOKE_PERMISSION,
} from "takosumi-contract";
import type { InstallConfig } from "takosumi-contract/install-configs";

export const OPERATOR_CONTROL_MCP_PATH = "/mcp/operator-control/v1" as const;
export const OPERATOR_CONTROL_MCP_ENABLED_ENV =
  "TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED" as const;
export const OPERATOR_CONTROL_MCP_INSTALL_CONFIG_ID =
  "takosumi-operator-control-mcp-v1" as const;
export const OPERATOR_CONTROL_MCP_INTERFACE_NAME =
  "takosumi.operator-control" as const;

const OPERATOR_CONTROL_MCP_TIMESTAMP = "2026-07-19T00:00:00.000Z";

/**
 * Operator-owned service-side declaration. The endpoint remains an ordinary
 * public Output and authorization remains an ordinary InterfaceBinding.
 */
export const OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT = Object.freeze({
  key: "operator-control-mcp",
  name: OPERATOR_CONTROL_MCP_INTERFACE_NAME,
  labels: { component: "operator-control-mcp" },
  spec: {
    type: MCP_SERVER_INTERFACE_TYPE,
    version: MCP_SERVER_INTERFACE_VERSION,
    document: {
      transport: "streamable-http",
      display: { title: "Takosumi Operator Control" },
    },
    inputs: {
      endpoint: {
        source: "capsule_output",
        outputName: "endpoint",
      },
    },
    access: {
      visibility: "workspace",
      resourceUriInput: "endpoint",
    },
  },
  bindings: [
    {
      key: "operator-control-mcp.installer",
      subject: { source: "installing_principal" },
      permissions: [MCP_SERVER_INVOKE_PERMISSION],
      delivery: { type: "oauth2" },
    },
  ],
} satisfies CapsuleInterfaceBlueprint);

/**
 * Explicit operator composition input. It is intentionally not part of the
 * default Store catalog: the route and its declaration are installed only by
 * an operator that enables the optional adapter.
 */
export const OPERATOR_CONTROL_MCP_INSTALL_CONFIG = Object.freeze({
  id: OPERATOR_CONTROL_MCP_INSTALL_CONFIG_ID,
  name: "takosumi-operator-control-mcp",
  modulePath: "opentofu-modules/operator-control-mcp",
  variableMapping: {},
  variablePresentation: [
    {
      name: "takosumi_origin",
      type: "string",
      format: "url",
      required: true,
      label: { ja: "Takosumi origin", en: "Takosumi origin" },
    },
    {
      name: "declare_interface_resource",
      type: "boolean",
      advanced: true,
      label: {
        ja: "module resource で Interface を宣言",
        en: "Declare Interface from the module resource",
      },
    },
  ],
  outputAllowlist: {
    endpoint: { from: "endpoint", type: "url", required: true },
  },
  policy: {},
  interfaceBlueprints: [OPERATOR_CONTROL_MCP_INTERFACE_BLUEPRINT],
  createdAt: OPERATOR_CONTROL_MCP_TIMESTAMP,
  updatedAt: OPERATOR_CONTROL_MCP_TIMESTAMP,
} satisfies InstallConfig);

/**
 * Canonical module-resource spec used by fixture/tests. The HCL resource owns
 * the same desired document as the blueprint; its ambient Capsule id is filled
 * by the provider and it never creates an InterfaceBinding.
 */
export const OPERATOR_CONTROL_MCP_MODULE_INTERFACE_SPEC = Object.freeze({
  type: MCP_SERVER_INTERFACE_TYPE,
  version: MCP_SERVER_INTERFACE_VERSION,
  document: {
    transport: "streamable-http",
    display: { title: "Takosumi Operator Control" },
  },
  inputs: {
    endpoint: {
      source: "capsule_output",
      capsuleId: "<ambient-capsule-id>",
      outputName: "endpoint",
    },
  },
  access: {
    visibility: "workspace",
    resourceUriInput: "endpoint",
  },
} satisfies InterfaceSpec);

export function operatorControlMcpEnabled(env: {
  readonly [OPERATOR_CONTROL_MCP_ENABLED_ENV]?: unknown;
}): boolean {
  return env[OPERATOR_CONTROL_MCP_ENABLED_ENV] === "1";
}

export function operatorControlMcpResource(origin: string): string {
  const url = new URL(OPERATOR_CONTROL_MCP_PATH, origin);
  url.search = "";
  url.hash = "";
  return url.href;
}

/** Exact host proof used by Interface oauth2 readiness/issuance checks. */
export function operatorControlMcpResourceAuthorized(
  env: {
    readonly [OPERATOR_CONTROL_MCP_ENABLED_ENV]?: unknown;
    readonly TAKOSUMI_ACCOUNTS_ISSUER?: unknown;
  },
  input: {
    readonly ownerRef: { readonly kind: string; readonly id: string };
    readonly resource: string;
  },
): boolean {
  if (!operatorControlMcpEnabled(env) || input.ownerRef.kind !== "Capsule") {
    return false;
  }
  const issuer = env.TAKOSUMI_ACCOUNTS_ISSUER;
  if (typeof issuer !== "string" || issuer.trim() === "") return false;
  try {
    return input.resource === operatorControlMcpResource(issuer);
  } catch {
    return false;
  }
}

export interface OperatorControlMcpAuthority {
  readonly workspaceId: string;
  readonly dispatchPublicControl: (request: Request) => Promise<Response>;
  readonly capsuleWorkspaceId: (
    capsuleId: string,
  ) => Promise<string | undefined>;
  readonly runWorkspaceId: (runId: string) => Promise<string | undefined>;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

const TOOLS = Object.freeze([
  {
    name: "takosumi_capsules_list",
    description:
      "List Capsules in the Workspace authorized by the current InterfaceBinding.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "takosumi_capsule_plan",
    description:
      "Create a policy-checked plan Run for one Capsule in the bound Workspace.",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: { type: "string", minLength: 1 },
        runnerProfileId: { type: "string", minLength: 1 },
      },
      required: ["capsuleId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "takosumi_run_get",
    description:
      "Read one Run from the Workspace authorized by the current InterfaceBinding.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", minLength: 1 } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "takosumi_run_approve",
    description:
      "Approve a reviewed Run in the bound Workspace through the public control service.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        reason: { type: "string", maxLength: 1024 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "takosumi_run_apply",
    description:
      "Apply a reviewed saved plan in the bound Workspace; Takosumi rebuilds and verifies the apply guard.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", minLength: 1 } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
] as const);

/** The catalog belongs to this optional adapter, never to Takos itself. */
export const OPERATOR_CONTROL_MCP_TOOLS = TOOLS;

/**
 * Minimal stateless Streamable HTTP MCP server. Authentication is deliberately
 * outside this function: the platform route must introspect one fresh
 * Interface OAuth token before calling it for every POST.
 */
export async function handleOperatorControlMcpRequest(
  request: Request,
  authority: OperatorControlMcpAuthority,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }
  const text = await request.text();
  if (text.length > 1_048_576) {
    return jsonRpcResponse(
      jsonRpcError(null, -32600, "request too large"),
      413,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return jsonRpcResponse(jsonRpcError(null, -32700, "parse error"), 400);
  }
  if (!isJsonRpcRequest(value)) {
    return jsonRpcResponse(jsonRpcError(null, -32600, "invalid request"), 400);
  }
  if (value.method === "notifications/initialized" && value.id === undefined) {
    return new Response(null, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  }
  if (value.id === undefined) {
    return new Response(null, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  }
  switch (value.method) {
    case "initialize":
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: value.id,
        result: {
          protocolVersion: MCP_SERVER_INTERFACE_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "takosumi-operator-control", version: "1" },
        },
      });
    case "ping":
      return jsonRpcResponse({ jsonrpc: "2.0", id: value.id, result: {} });
    case "tools/list":
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: value.id,
        result: { tools: TOOLS },
      });
    case "tools/call":
      return await callTool({ ...value, id: value.id }, authority);
    default:
      return jsonRpcResponse(
        jsonRpcError(value.id, -32601, "method not found"),
        404,
      );
  }
}

async function callTool(
  request: JsonRpcRequest & { readonly id: JsonRpcId },
  authority: OperatorControlMcpAuthority,
): Promise<Response> {
  const params = record(request.params);
  const name = textValue(params.name);
  const args = record(params.arguments);
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return jsonRpcResponse(jsonRpcError(request.id, -32602, "unknown tool"));
  }
  let controlRequest: Request;
  try {
    controlRequest = await publicControlRequest(tool.name, args, authority);
  } catch (error) {
    return toolResult(request.id, 403, {
      error: "access_denied",
      error_description:
        error instanceof Error ? error.message : "target is not authorized",
    });
  }
  let response: Response;
  try {
    response = await authority.dispatchPublicControl(controlRequest);
  } catch {
    return toolResult(request.id, 500, {
      error: "control_unavailable",
      error_description: "Takosumi control operation failed",
    });
  }
  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = bodyText === "" ? null : (JSON.parse(bodyText) as unknown);
  } catch {
    // The public control service may return a bounded non-JSON error. Preserve
    // it as text without forwarding response headers or any credential.
  }
  return toolResult(request.id, response.status, body);
}

async function publicControlRequest(
  name: (typeof TOOLS)[number]["name"],
  args: Record<string, unknown>,
  authority: OperatorControlMcpAuthority,
): Promise<Request> {
  const origin = "https://takosumi-control.invalid";
  if (name === "takosumi_capsules_list") {
    assertOnlyKeys(args, []);
    return new Request(
      `${origin}/api/v1/workspaces/${encodeURIComponent(authority.workspaceId)}/capsules`,
      { method: "GET" },
    );
  }
  if (name === "takosumi_capsule_plan") {
    assertOnlyKeys(args, ["capsuleId", "runnerProfileId"]);
    const capsuleId = requiredId(args.capsuleId, "capsuleId");
    await requireWorkspaceTarget(
      await authority.capsuleWorkspaceId(capsuleId),
      authority.workspaceId,
    );
    const runnerProfileId = optionalText(
      args.runnerProfileId,
      "runnerProfileId",
    );
    return jsonRequest(
      `${origin}/api/v1/capsules/${encodeURIComponent(capsuleId)}/plan`,
      runnerProfileId ? { runnerProfileId } : {},
    );
  }
  const runId = requiredId(args.runId, "runId");
  await requireWorkspaceTarget(
    await authority.runWorkspaceId(runId),
    authority.workspaceId,
  );
  if (name === "takosumi_run_get") {
    assertOnlyKeys(args, ["runId"]);
    return new Request(`${origin}/api/v1/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
    });
  }
  if (name === "takosumi_run_approve") {
    assertOnlyKeys(args, ["runId", "reason"]);
    const reason = optionalText(args.reason, "reason", 1024);
    return jsonRequest(
      `${origin}/api/v1/runs/${encodeURIComponent(runId)}/approve`,
      reason ? { reason } : {},
    );
  }
  assertOnlyKeys(args, ["runId"]);
  return jsonRequest(
    `${origin}/api/v1/runs/${encodeURIComponent(runId)}/apply`,
    {},
  );
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requireWorkspaceTarget(
  targetWorkspaceId: string | undefined,
  boundWorkspaceId: string,
): Promise<void> {
  if (!targetWorkspaceId || targetWorkspaceId !== boundWorkspaceId) {
    throw new Error("target is outside the InterfaceBinding Workspace");
  }
}

function toolResult(id: JsonRpcId, status: number, body: unknown): Response {
  return jsonRpcResponse({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      isError: status < 200 || status >= 300,
      structuredContent: { status, body },
    },
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function jsonRpcResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.jsonrpc === "2.0" &&
    typeof candidate.method === "string" &&
    (candidate.id === undefined ||
      candidate.id === null ||
      typeof candidate.id === "string" ||
      (typeof candidate.id === "number" && Number.isFinite(candidate.id)))
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredId(value: unknown, field: string): string {
  const result = optionalText(value, field);
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength = 128,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("tool arguments contain unsupported fields");
  }
}
