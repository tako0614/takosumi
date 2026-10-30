/**
 * Legacy Workspace usage telemetry (TASK-0118 Phase 9, stage 9.0).
 *
 * Workspace is being removed as a product concept. Before any compatibility
 * route can return 410 (stage 9.3) or any Workspace claim can stop (stage
 * 9.4), production must show that nothing still depends on them for seven
 * consecutive days. This module is the single place that recognises such a
 * dependency and reports it, so the gate can be read from Workers Logs (or any
 * log sink of a self-hosted deployment) without querying a database.
 *
 * Every report is built from bounded values: a route TEMPLATE, never a path; a
 * credential KIND, never a token; how the Workspace was SELECTED, never which
 * one; a client FAMILY from a fixed vocabulary, never a raw `User-Agent` or
 * `Takosumi-Client` value; and booleans for "bound to a Workspace" or "bound
 * to apps". No account, subject, Workspace, request or token id is ever
 * written. The one identifier is the registered OAuth `clientId` that sent the
 * request or received the claim. It identifies an app integration or an
 * installation, never a person or a token: a Capsule's public client (`tko_…`)
 * is registered per installation, so its client id maps 1:1 to that installed
 * Capsule. Stage 9.4 needs it to find the installation that still reads
 * Workspace claims.
 *
 * Only authenticated requests are reported: a request refused before its
 * credential was accepted (401, or 403 before authentication) depends on
 * nothing and is not counted.
 *
 * Responses to a legacy route also carry RFC 9745 `Deprecation`, an optional
 * RFC 8594 `Sunset` (only when the operator has scheduled stage 9.3), and RFC
 * 8288 `Link` relations to the deprecation notice and, when it is a concrete
 * URI, the successor route.
 */

import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "./control-route-inventory.ts";

/** Structured log event names. Stable: operators query Workers Logs by them. */
export const LEGACY_WORKSPACE_ROUTE_EVENT = "legacy_workspace_route" as const;
export const LEGACY_WORKSPACE_CLAIM_EVENT =
  "legacy_workspace_claim_emitted" as const;

/** Worker metric counter recorded by the Cloudflare platform composition. */
export const LEGACY_WORKSPACE_ROUTE_METRIC =
  "takosumi_legacy_workspace_route_count" as const;

/**
 * Optional client self-identification header (`<name>` or `<name>/<version>`).
 * Deliberately not `x-takosumi-*`: that prefix is reserved for authority-shaped
 * headers, which browser billing refuses and the shared-auth and extension
 * boundaries strip.
 */
export const TAKOSUMI_CLIENT_HEADER = "takosumi-client" as const;

/**
 * Operator setting for the RFC 8594 `Sunset` header. Unset means no Sunset is
 * announced; stage 9.3 sets it once its date is approved.
 */
export const LEGACY_WORKSPACE_SUNSET_ENV =
  "TAKOSUMI_LEGACY_WORKSPACE_SUNSET" as const;

/**
 * RFC 9745 deprecation date: 2026-10-28T00:00:00Z, the day the TASK-0118
 * decision retired Workspace as a concept.
 */
export const LEGACY_WORKSPACE_DEPRECATION = "@1793145600" as const;

/** Where operators read what replaces each legacy surface. */
export const LEGACY_WORKSPACE_DEPRECATION_NOTICE =
  "https://takosumi.com/docs/reference/api#legacy-workspace-routes" as const;

/**
 * Which kind of Workspace dependency a request shows.
 *
 * - `workspace_route`: a `/api/v1/workspaces/*`, `/projects/*` or
 *   `/views/workspaces.v1` route.
 * - `workspace_query`: an otherwise current route selected by `?workspaceId=`.
 * - `workspace_body`: an otherwise current route given `workspaceId` in its
 *   JSON body.
 * - `workspace_projection`: a dashboard bootstrap that still projects the
 *   Workspace list (the server default).
 * - `shared_workspace`: the shared-account Workspace directory.
 * - `billing_workspace`: browser billing selected by Workspace (reserved;
 *   stage 9B counts it from invocation logs).
 * - `interface_workspace`: the Interface API selected by Workspace (query,
 *   header, body or the credential's own Workspace; see `selector`).
 * - `platform_extension_workspace`: a platform extension route given a
 *   Workspace context (query, or the credential's own Workspace).
 * - `authorize_workspace`: an OIDC authorization request naming a Workspace.
 * - `pat_workspace`: a personal access token created for a Workspace.
 */
export type LegacyWorkspaceSurface =
  | "workspace_route"
  | "workspace_query"
  | "workspace_body"
  | "workspace_projection"
  | "shared_workspace"
  | "billing_workspace"
  | "interface_workspace"
  | "platform_extension_workspace"
  | "authorize_workspace"
  | "pat_workspace";

/** Which composition entry served the request. */
export type LegacyWorkspaceEntry =
  | "public"
  | "operator_mcp"
  | "shared_auth"
  | "platform";

/**
 * Credential kind as resolved by the authenticating composition. The platform
 * kinds (`service-token` … `deploy-control`) appear only on platform-served
 * surfaces.
 */
export type LegacyWorkspaceCredential =
  | "session"
  | "personal-access-token"
  | "oauth-access-token"
  | "interface-oauth-token"
  | "service-token"
  | "run-credential"
  | "protocol-credential"
  | "deploy-control"
  | "unknown";

/**
 * How a platform-served request selected its Workspace:
 * `?workspaceId=` (`query`), the `x-takosumi-platform-workspace-id` header
 * (`header`), a `workspaceId` body field (`body`), or implicitly from the
 * Workspace its credential is bound to (`session`).
 */
export type LegacyWorkspaceSelector = "query" | "header" | "body" | "session";

export interface LegacyWorkspaceUse {
  readonly surface: LegacyWorkspaceSurface;
  /** Route template; never a concrete path or query value. */
  readonly route: string;
  /** Current replacement route, when one exists today. */
  readonly successor?: string;
  /** How the Workspace was selected; set on platform-served surfaces. */
  readonly selector?: LegacyWorkspaceSelector;
}

export interface LegacyWorkspaceRouteReport {
  readonly use: LegacyWorkspaceUse;
  readonly method: string;
  readonly status: number;
  readonly entry: LegacyWorkspaceEntry;
  readonly credential: LegacyWorkspaceCredential;
  readonly workspaceBound: boolean;
  readonly appBound: boolean;
  readonly clientFamily: string;
  /**
   * Registered OAuth client id; only for an OAuth or Interface OAuth access
   * token. Identifies an app integration or installation, never a person or a
   * token.
   */
  readonly clientId?: string;
}

/**
 * Where a compatibility Workspace claim was handed out.
 * `personal_access_introspection` is a Workspace-bound personal access token
 * introspected by a resource server; `personal_access_authority` is such a
 * token reading its own authority (`/api/v1/account/tokens/current`);
 * `personal_access_bearer` is a PAT bound only to a Workspace (no apps)
 * authenticating an Accounts request directly, on any route.
 */
export type LegacyWorkspaceClaimSurface =
  | "id_token"
  | "userinfo"
  | "introspection"
  | "interface_oauth_userinfo"
  | "interface_oauth_introspection"
  | "personal_access_introspection"
  | "personal_access_authority"
  | "personal_access_bearer";

export interface LegacyWorkspaceClaimReport {
  readonly surface: LegacyWorkspaceClaimSurface;
  /**
   * The registered OAuth client that received the claim (for
   * `personal_access_introspection`, the introspecting client). Identifies an
   * app integration or installation, never a person or a token.
   */
  readonly clientId?: string;
  /** True when the same claim set also carried `capsule_id`. */
  readonly capsuleBound: boolean;
  /** True when the same claim set also carried `app_role`. */
  readonly appRole: boolean;
  /** True when the flat `workspace_memberships` claim was emitted too. */
  readonly memberships: boolean;
}

/**
 * The current replacement of each legacy route. Only routes with a
 * replacement today are listed; the rest get theirs in stage 9.1. A templated
 * replacement (`{capsuleId}`) is documented in the API reference but never
 * sent as a `Link` target: it is not a valid URI.
 */
const WORKSPACE_ROUTE_SUCCESSORS: Readonly<Record<string, string>> = {
  "GET /api/v1/workspaces": "/api/v1/apps",
  "GET /api/v1/workspaces/{workspaceId}/capsules": "/api/v1/apps",
  "GET /api/v1/workspaces/{workspaceId}/installed-apps": "/api/v1/apps",
  "POST /api/v1/workspaces/{workspaceId}/install-plans": "/api/v1/install-plans",
  "GET /api/v1/workspaces/{workspaceId}/members":
    "/api/v1/capsules/{capsuleId}/members",
  "GET /api/v1/workspaces/{workspaceId}/runs": "/api/v1/capsules/{capsuleId}/runs",
  "GET /api/v1/workspaces/{workspaceId}/usage": "/api/v1/usage",
  "GET /api/v1/workspaces/{workspaceId}/billing": "/api/v1/usage",
  "POST /api/v1/workspaces/{workspaceId}/source-ref-resolutions/stable-semver":
    "/api/v1/source-ref-resolutions",
  "POST /api/v1/workspaces/{workspaceId}/plan-update":
    "/api/v1/capsules/{capsuleId}/plan",
  "POST /api/v1/workspaces/{workspaceId}/drift-check":
    "/api/v1/capsules/{capsuleId}/drift-check",
  "POST /api/v1/workspaces/{workspaceId}/backups":
    "/api/v1/capsules/{capsuleId}/backups",
};

/** Routes that take `?workspaceId=` today. The query value is never reported. */
const WORKSPACE_QUERY_RESOURCES = new Set([
  "connections",
  "sources",
  "capsule-configs",
  "dashboard",
  "provider-connections",
]);

const WORKSPACE_QUERY_SUCCESSORS: Readonly<Record<string, string>> = {
  connections: "/api/v1/connections",
};

/**
 * Classify one `/api/v1` control request from its method, normalized path
 * segments (after `/api/v1`) and query. Pure; never reads the body.
 */
export function classifyLegacyWorkspaceControlRequest(
  method: string,
  segments: readonly string[],
  searchParams: URLSearchParams,
): LegacyWorkspaceUse | undefined {
  const upper = method.toUpperCase();
  const head = segments[0];
  if (head === "workspaces" || head === "projects") {
    const route = controlRouteTemplate(upper, segments) ??
      `/api/v1/${head}/*`;
    const successor = WORKSPACE_ROUTE_SUCCESSORS[`${upper} ${route}`];
    return {
      surface: "workspace_route",
      route,
      ...(successor ? { successor } : {}),
    };
  }
  if (head === "views" && segments[1] === "workspaces.v1") {
    return {
      surface: "workspace_route",
      route: "/api/v1/views/workspaces.v1",
      successor: "/api/v1/apps",
    };
  }
  if (head !== undefined && WORKSPACE_QUERY_RESOURCES.has(head) &&
    searchParams.has("workspaceId")) {
    const template = controlRouteTemplate(upper, segments) ??
      `/api/v1/${head}/*`;
    const successor = WORKSPACE_QUERY_SUCCESSORS[head];
    return {
      surface: "workspace_query",
      route: `${template}?workspaceId`,
      ...(successor ? { successor } : {}),
    };
  }
  if (head === "sources" && segments.length === 1 && upper === "POST") {
    // Source creation still requires `workspaceId` in its body.
    return legacyWorkspaceBodyUse(upper, segments);
  }
  // The bootstrap's Workspace inventory is opt-in since TASK-0118 9.1-a, so
  // only an explicit `includeWorkspaces=true` is a Workspace use.
  if (head === "dashboard" && segments[1] === "bootstrap" &&
    segments.length === 2 && upper === "GET" &&
    searchParams.get("includeWorkspaces") === "true") {
    return {
      surface: "workspace_projection",
      route: "/api/v1/dashboard/bootstrap?includeWorkspaces",
    };
  }
  return undefined;
}

/**
 * The body-selected variant of a current route. Handlers call this after they
 * have parsed a JSON body that names a Workspace.
 */
export function legacyWorkspaceBodyUse(
  method: string,
  segments: readonly string[],
): LegacyWorkspaceUse {
  const upper = method.toUpperCase();
  const head = segments[0] ?? "";
  const template = controlRouteTemplate(upper, segments) ?? `/api/v1/${head}/*`;
  const successor = WORKSPACE_QUERY_SUCCESSORS[head];
  return {
    surface: "workspace_body",
    route: `${template}#workspaceId`,
    ...(successor ? { successor } : {}),
  };
}

/** Inventory template for a control route; `undefined` when none matches. */
export function controlRouteTemplate(
  method: string,
  segments: readonly string[],
): string | undefined {
  const upper = method.toUpperCase();
  for (const endpoint of PUBLIC_SESSION_CONTROL_ENDPOINTS) {
    if (endpoint.method !== upper) continue;
    const parts = endpoint.path.split("/").slice(3);
    if (parts.length !== segments.length) continue;
    if (parts.every((part, index) =>
      /^\{[A-Za-z]+\}$/u.test(part)
        ? (segments[index] ?? "").length > 0
        : part === segments[index]
    )) {
      return endpoint.path;
    }
  }
  return undefined;
}

const KNOWN_CLIENTS = new Set([
  "takosumi-dashboard",
  "takosumi-cli",
  "takosumi-operator-mcp",
  "takosumi-mobile",
  "takosumi-dev-server",
  "takosumi-hosted",
  "takoserver",
  "takos",
  "takos-git",
  "takos-storage",
  "takos-office",
  "takos-computer",
  "yurucommu",
  "yurumeet",
]);

/**
 * Client family from a fixed vocabulary. A self-identifying client is reported
 * by name when the name is known (`Takosumi-Client: <name>/<version>`);
 * anything else falls back to a coarse User-Agent family. The raw header
 * values are never reported.
 */
export function legacyWorkspaceClientFamily(headers: Headers): string {
  const hint = headers.get(TAKOSUMI_CLIENT_HEADER);
  if (hint !== null) {
    const name = hint.split("/", 1)[0]?.trim().toLowerCase() ?? "";
    return KNOWN_CLIENTS.has(name) ? name : "client:unknown";
  }
  const agent = headers.get("user-agent") ?? "";
  if (agent.trim() === "") return "ua:none";
  if (/\bBun\//u.test(agent)) return "ua:bun";
  if (/\bDeno\//u.test(agent)) return "ua:deno";
  if (/^(node|undici|node-fetch|axios)\b/iu.test(agent)) return "ua:node";
  if (/^curl\//iu.test(agent)) return "ua:curl";
  if (/^(python-requests|python-urllib|aiohttp|httpx)\b/iu.test(agent)) {
    return "ua:python";
  }
  if (/^Go-http-client\//u.test(agent)) return "ua:go";
  if (/^okhttp\//iu.test(agent)) return "ua:okhttp";
  if (/\bCFNetwork\//u.test(agent)) return "ua:apple-native";
  if (/^Mozilla\//u.test(agent)) {
    return /\bMobile\b/u.test(agent) ? "ua:browser-mobile" : "ua:browser";
  }
  return "ua:other";
}

/**
 * Parse the operator `Sunset` setting into an RFC 9110 IMF-fixdate. Accepts an
 * ISO date or date-time, or an HTTP-date. Unset or blank means no Sunset.
 */
export function parseLegacyWorkspaceSunset(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${LEGACY_WORKSPACE_SUNSET_ENV} must be an ISO 8601 date or an HTTP-date`,
    );
  }
  return new Date(parsed).toUTCString();
}

/**
 * Copy of `response` with the deprecation headers for `use`. A response that
 * cannot carry a body replacement (a protocol switch) is returned unchanged.
 */
export function withLegacyWorkspaceDeprecation(
  response: Response,
  use: LegacyWorkspaceUse,
  options: { readonly sunset?: string } = {},
): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("Deprecation", LEGACY_WORKSPACE_DEPRECATION);
  if (options.sunset) headers.set("Sunset", options.sunset);
  const links = [
    `<${LEGACY_WORKSPACE_DEPRECATION_NOTICE}>; rel="deprecation"; type="text/html"`,
    ...(use.successor && isConcreteSuccessorPath(use.successor)
      ? [`<${use.successor}>; rel="successor-version"`]
      : []),
  ];
  const existing = headers.get("Link");
  headers.set("Link", existing ? `${existing}, ${links.join(", ")}` : links.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * True for an absolute-path URI reference made only of RFC 3986 path
 * characters. A route template (`{capsuleId}`) is not a URI, and a strict
 * client may drop the whole `Link` header (the deprecation relation included)
 * when one target is invalid, so templates are never linked.
 */
export function isConcreteSuccessorPath(value: string): boolean {
  return /^\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/u.test(value);
}

/** Writes one `legacy_workspace_route` event. Never throws. */
export function reportLegacyWorkspaceRoute(
  report: LegacyWorkspaceRouteReport,
  sink: (line: string) => void = (line) => console.info(line),
): void {
  try {
    sink(JSON.stringify({
      event: LEGACY_WORKSPACE_ROUTE_EVENT,
      surface: report.use.surface,
      route: report.use.route,
      ...(report.use.selector ? { selector: report.use.selector } : {}),
      method: report.method.toUpperCase(),
      status: report.status,
      entry: report.entry,
      credential: report.credential,
      workspaceBound: report.workspaceBound,
      appBound: report.appBound,
      clientFamily: report.clientFamily,
      ...((report.credential === "oauth-access-token" ||
          report.credential === "interface-oauth-token") &&
          report.clientId !== undefined &&
          SAFE_CLIENT_ID.test(report.clientId)
        ? { clientId: report.clientId }
        : {}),
    }));
  } catch {
    // Telemetry must never affect the response.
  }
}

/** Writes one `legacy_workspace_claim_emitted` event. Never throws. */
export function reportLegacyWorkspaceClaim(
  report: LegacyWorkspaceClaimReport,
  sink: (line: string) => void = (line) => console.info(line),
): void {
  try {
    sink(JSON.stringify({
      event: LEGACY_WORKSPACE_CLAIM_EVENT,
      surface: report.surface,
      ...(report.clientId !== undefined && SAFE_CLIENT_ID.test(report.clientId)
        ? { clientId: report.clientId }
        : {}),
      capsuleBound: report.capsuleBound,
      appRole: report.appRole,
      memberships: report.memberships,
    }));
  } catch {
    // Telemetry must never affect the response.
  }
}

/** Id-free template of an `/api/v1/interfaces` path. */
export function interfaceApiRouteTemplate(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).slice(2);
  if (segments[0] !== "interfaces") return "/api/v1/interfaces/*";
  const parts = ["/api/v1/interfaces"];
  if (segments.length > 1) parts.push("{interfaceId}");
  if (segments.length > 2) {
    const leaf = segments[2]!;
    parts.push(["bindings", "token", "status"].includes(leaf) ? leaf : "*");
  }
  if (segments.length > 3) parts.push("{bindingId}");
  if (segments.length > 4) parts.push("*");
  return parts.join("/");
}

/** Metric tags of one reported use: route template, selector, method, status. */
export function legacyWorkspaceUseMetricTags(
  use: LegacyWorkspaceUse,
  method: string,
  status: number,
): Record<string, string> {
  return {
    route: use.route,
    ...(use.selector ? { selector: use.selector } : {}),
    method: method.toUpperCase(),
    status: String(status),
  };
}

/**
 * Metric tags for a response an Accounts handler marked as deprecated, or
 * `undefined` for any other response. Platform-served uses supply their own
 * tags (`legacyWorkspaceUseMetricTags`); here the route is re-derived from the
 * request URL, and a use only visible in a parsed body is tagged `body`.
 */
export function legacyWorkspaceMetricTags(
  request: Request,
  response: Response,
): Record<string, string> | undefined {
  if (response.headers.get("Deprecation") !== LEGACY_WORKSPACE_DEPRECATION) {
    return undefined;
  }
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  let route = "body";
  if (url.pathname.startsWith("/api/v1/")) {
    const segments = url.pathname.slice("/api/v1".length).split("/").filter(Boolean);
    const use = classifyLegacyWorkspaceControlRequest(method, segments, url.searchParams);
    if (use) route = use.route;
    else if (segments[0] === "interfaces") {
      route = interfaceApiRouteTemplate(url.pathname);
    } else if (segments[0] === "account" && segments[1] === "shared-workspaces") {
      route = "/api/v1/account/shared-workspaces/*";
    }
  } else if (url.pathname === "/oauth/authorize") {
    route = "/oauth/authorize?workspace_id";
  }
  return { route, method, status: String(response.status) };
}

/** How long one isolate coalesces the counter of one tag set. */
export const LEGACY_WORKSPACE_METRIC_INTERVAL_MS = 60_000;

/** Tag sets tracked per isolate; beyond it every use is written directly. */
const LEGACY_WORKSPACE_METRIC_MAX_BUCKETS = 512;

/**
 * Per-isolate coalescing of `takosumi_legacy_workspace_route_count`, so a
 * legacy use costs at most one Control D1 write per tag set (route, selector,
 * method, status) per isolate per minute instead of one per request.
 *
 * It writes on the leading edge: the first use of a tag set in an isolate is
 * written at once, and later uses inside the interval are carried into that
 * tag set's next write. A tag set therefore can never read 0 while a use
 * happened (the 0-versus-nonzero question the stage 9.3 gate asks). A write
 * that fails is handed back through `restore`, so the next use of that tag set
 * retries it at once. The only loss is the carried tail of an isolate that is
 * evicted before its next write (or a failure with no later use in that
 * isolate), which can make the total low. The per-use log line is not
 * coalesced and remains the source for the gate.
 */
export class LegacyWorkspaceRouteCounter {
  readonly #intervalMs: number;
  readonly #buckets = new Map<string, { lastWriteAt: number; carried: number }>();

  constructor(intervalMs: number = LEGACY_WORKSPACE_METRIC_INTERVAL_MS) {
    this.#intervalMs = intervalMs;
  }

  /**
   * Counts one use at `now`. Returns the value to write now (this use plus
   * any carried uses), or `undefined` when the tag set was written within the
   * interval and the use was carried.
   */
  add(tags: Readonly<Record<string, string>>, now: number): number | undefined {
    const key = legacyWorkspaceMetricKey(tags);
    const bucket = this.#buckets.get(key);
    if (bucket && now - bucket.lastWriteAt < this.#intervalMs) {
      bucket.carried += 1;
      return undefined;
    }
    const value = (bucket?.carried ?? 0) + 1;
    if (bucket || this.#buckets.size < LEGACY_WORKSPACE_METRIC_MAX_BUCKETS) {
      this.#buckets.set(key, { lastWriteAt: now, carried: 0 });
    }
    return value;
  }

  /**
   * Returns a value whose write failed: it is carried again and the tag set
   * is reopened, so the next use writes at once with it instead of waiting
   * out the interval.
   */
  restore(tags: Readonly<Record<string, string>>, value: number): void {
    const key = legacyWorkspaceMetricKey(tags);
    const bucket = this.#buckets.get(key);
    if (bucket) {
      bucket.carried += value;
      bucket.lastWriteAt = Number.NEGATIVE_INFINITY;
    } else if (this.#buckets.size < LEGACY_WORKSPACE_METRIC_MAX_BUCKETS) {
      this.#buckets.set(key, {
        lastWriteAt: Number.NEGATIVE_INFINITY,
        carried: value,
      });
    }
  }
}

function legacyWorkspaceMetricKey(tags: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(tags).sort().map((name) => [name, tags[name]]),
  );
}

/** A client id is reported only in a bounded, printable shape. */
const SAFE_CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * Collects at most one legacy use per request. Handlers that discover a
 * Workspace in a parsed body mark it; the dispatcher reads it once the
 * response exists. The first mark wins, so a URL classification is never
 * replaced by a later body detail.
 */
export class LegacyWorkspaceUseRecorder {
  #use: LegacyWorkspaceUse | undefined;

  constructor(initial?: LegacyWorkspaceUse) {
    this.#use = initial;
  }

  mark(use: LegacyWorkspaceUse): void {
    this.#use ??= use;
  }

  get use(): LegacyWorkspaceUse | undefined {
    return this.#use;
  }
}
