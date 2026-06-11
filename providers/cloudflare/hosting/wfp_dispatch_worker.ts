import type { WorkersForPlatformsDispatchNamespace } from "../../../worker/src/bindings.ts";
import { TENANT_SCRIPT_NAME } from "./wfp_script_name.ts";

export interface CloudflareWfpDispatchEnv extends Record<string, unknown> {
  readonly TAKOSUMI_TENANT_DISPATCH: WorkersForPlatformsDispatchNamespace;
}

export interface CloudflareWfpDispatchWorker {
  fetch(request: Request, env: CloudflareWfpDispatchEnv): Promise<Response>;
}

/*
 * This checked-in Worker is the WfP HTTP ingress dispatcher only. Tenant
 * egress allowlist enforcement requires an operator-configured WfP outbound
 * Worker on the dispatch namespace, not a binding or secret in this Worker.
 */
const BLOCKED_FORWARD_HEADERS = [
  "x-takosumi-internal-auth",
  "x-takosumi-deploy-control-token",
  "x-takosumi-provider-credential",
  "x-takosumi-state-backend-credential",
  "x-takosumi-secret-ref",
  "x-takosumi-operator-secret",
] as const;

export function createCloudflareWfpDispatchWorker(): CloudflareWfpDispatchWorker {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const scriptName = tenantScriptNameFromUrl(url);
      if (!scriptName) {
        return jsonResponse({ error: "tenant_worker_not_found" }, 404);
      }

      const userWorker = env.TAKOSUMI_TENANT_DISPATCH.get(scriptName);
      return await userWorker.fetch(requestForUserWorker(request, scriptName));
    },
  };
}

export default createCloudflareWfpDispatchWorker();

export function tenantScriptNameFromUrl(url: URL): string | undefined {
  const [scriptName] = url.pathname.split("/").filter((part) => part.length > 0);
  if (!scriptName || !TENANT_SCRIPT_NAME.test(scriptName)) return undefined;
  return scriptName;
}

export function requestForUserWorker(
  request: Request,
  scriptName: string,
): Request {
  const headers = new Headers(request.headers);
  for (const header of BLOCKED_FORWARD_HEADERS) headers.delete(header);
  headers.set("x-takosumi-tenant-worker", scriptName);
  headers.set("x-takosumi-dispatch-runtime", "cloudflare-workers-for-platforms");
  return new Request(request, { headers });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
