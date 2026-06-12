import { TENANT_SCRIPT_NAME } from "./wfp_script_name.ts";
import { verifyCfProxyScope } from "./cf_proxy_signature.ts";

/**
 * Managed cf-proxy (runner-side worker-script redirect).
 *
 * The cloudflare provider v5 cannot place a script into a Workers-for-Platforms
 * dispatch namespace. So for a managed (takosumi-hosted) run, the control plane
 * points the cloudflare provider's `base_url` at this proxy:
 *
 *   <origin>/internal/cf-proxy/<namespace>/<slug>/client/v4
 *
 * A managed capsule stays PLAIN OpenTofu — a normal `cloudflare_workers_script`
 * (+ normal KV/D1/R2 + normal `bindings`). The proxy transparently rewrites
 * worker-script API paths into the dispatch namespace and passes everything else
 * straight through to api.cloudflare.com:
 *
 *   /client/v4/accounts/{id}/workers/scripts/{name}[/sub]
 *     -> /client/v4/accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{slug}-{name}[/sub]
 *
 * `{slug}` (the install slug) prefixes the script name so names are globally
 * unique across installs in the shared namespace; the final name is the
 * dispatcher's routing key and is validated against the same DNS-label rule.
 * The `/subdomain` sub-resource (no equivalent for namespace scripts) is a
 * no-op success. KV/D1/R2/etc. pass through unchanged, so the script's binding
 * map references real created resources.
 *
 * Integrity: the namespace + slug come from the base_url PATH, which the control
 * plane sets and a capsule cannot override (the generated root passes providers
 * in -> a capsule provider block fails tofu plan). The operator API token rides
 * the request `Authorization` and is forwarded as-is. To stop the edge route
 * being an unauthenticated open relay, the control plane signs the scope at
 * run-dispatch time (`cf_proxy_signature.ts`) and embeds the signature as the
 * FIRST path segment; the proxy verifies it (constant-time, unexpired) BEFORE
 * forwarding. The runner cannot forge it — only the control plane holds the secret.
 */

const CF_PROXY_PREFIX = "/internal/cf-proxy";
const CF_API_ORIGIN = "https://api.cloudflare.com";

const WORKER_SCRIPT_PATH =
  /^\/client\/v4\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)(\/.*)?$/;

export interface CfProxyScope {
  /** Control-plane signature segment `<expMs>.<mac>` binding ns+slug+expiry. */
  readonly signature: string;
  readonly namespace: string;
  readonly slug: string;
  /** API path beginning at `/client/v4/...`. */
  readonly apiPath: string;
}

/** Parses `/internal/cf-proxy/<sig>/<namespace>/<slug>/client/v4/<rest>`. */
export function parseCfProxyPath(pathname: string): CfProxyScope | undefined {
  if (pathname !== CF_PROXY_PREFIX && !pathname.startsWith(`${CF_PROXY_PREFIX}/`)) {
    return undefined;
  }
  const parts = pathname.slice(CF_PROXY_PREFIX.length + 1).split("/");
  // parts = [<sig>, <namespace>, <slug>, "client", "v4", ...rest]
  if (parts.length < 5 || parts[3] !== "client" || parts[4] !== "v4") {
    return undefined;
  }
  const signature = parts[0]!;
  const namespace = decodeURIComponent(parts[1]!);
  const slug = decodeURIComponent(parts[2]!);
  if (!signature || !namespace || !slug) return undefined;
  return { signature, namespace, slug, apiPath: `/${parts.slice(3).join("/")}` };
}

export interface CfProxyRequestOptions {
  /** HMAC secret the control plane signed the scope with. Absent -> disabled. */
  readonly signingSecret?: string;
  /** Clock for expiry checks; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

/**
 * Rewrites the cf-proxy api path into the upstream cloudflare api path for a
 * given scope. Returns a string path, or `{ noop: true }` for the subdomain
 * sub-resource (namespace scripts have no workers.dev subdomain), or
 * `{ error }` when the derived script name is not a valid dispatch name.
 */
export function rewriteCfProxyApiPath(
  scope: CfProxyScope,
): { path: string } | { noop: true } | { error: string } {
  const match = WORKER_SCRIPT_PATH.exec(scope.apiPath);
  if (!match) return { path: scope.apiPath }; // KV/D1/R2/etc. pass through.
  const [, accountId, name, sub] = match;
  if (sub === "/subdomain") return { noop: true };
  const scriptName = `${scope.slug}-${name}`;
  if (!TENANT_SCRIPT_NAME.test(scriptName)) {
    return {
      error: `derived managed script name "${scriptName}" is not a valid dispatch name`,
    };
  }
  return {
    path:
      `/client/v4/accounts/${accountId}/workers/dispatch/namespaces/` +
      `${encodeURIComponent(scope.namespace)}/scripts/${scriptName}${sub ?? ""}`,
  };
}

export async function handleCfProxyRequest(
  request: Request,
  url: URL,
  options: CfProxyRequestOptions = {},
): Promise<Response> {
  const scope = parseCfProxyPath(url.pathname);
  if (!scope) return cfErrorResponse(404, "cf_proxy_path_invalid");
  // Fail closed: the managed cf-proxy only forwards when the control plane
  // signed this exact (namespace, slug) scope and it has not expired. Without a
  // configured secret the proxy is disabled; an invalid/expired/tampered
  // signature is rejected BEFORE any upstream fetch.
  if (!options.signingSecret) {
    return cfErrorResponse(404, "cf_proxy_disabled");
  }
  const signatureOk = await verifyCfProxyScope(
    options.signingSecret,
    scope.signature,
    {
      namespace: scope.namespace,
      slug: scope.slug,
      nowMs: options.nowMs ?? Date.now(),
    },
  );
  if (!signatureOk) {
    return cfErrorResponse(403, "cf_proxy_signature_invalid");
  }
  const rewritten = rewriteCfProxyApiPath(scope);
  if ("error" in rewritten) return cfErrorResponse(400, rewritten.error);
  if ("noop" in rewritten) {
    // The workers.dev subdomain has no namespace-script equivalent; echo a
    // success so `cloudflare_workers_script_subdomain` stays stable. Ingress is
    // the WfP dispatcher, not a workers.dev subdomain.
    return Response.json(
      { success: true, errors: [], messages: [], result: { enabled: true } },
      { status: 200 },
    );
  }
  const upstream = new URL(`${CF_API_ORIGIN}${rewritten.path}`);
  upstream.search = url.search;
  return await fetch(new Request(upstream.toString(), request));
}

function cfErrorResponse(status: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ message }], messages: [], result: null },
    { status },
  );
}
