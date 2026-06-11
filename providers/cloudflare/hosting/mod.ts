/**
 * Cloudflare managed-hosting worker code (cf-proxy + Workers-for-Platforms
 * dispatch + the shared tenant script-name rule).
 *
 * This is the provider-specific implementation that the managed-provider
 * registry (`@takosumi/providers`) refers to: the runner-side cf-proxy that
 * rewrites worker-script API paths into a dispatch namespace, and the WfP
 * ingress dispatcher that routes tenant traffic. These modules target the
 * workerd runtime (typechecked via `tsconfig.worker.json`, bundled via
 * `check:cloudflare-worker-build`), so importers reach them by explicit path
 * rather than through the DOM-typed base `tsc` pass.
 */
export {
  type CfProxyScope,
  handleCfProxyRequest,
  parseCfProxyPath,
  rewriteCfProxyApiPath,
} from "./cf_proxy_worker.ts";
export {
  type CloudflareWfpDispatchEnv,
  type CloudflareWfpDispatchWorker,
  createCloudflareWfpDispatchWorker,
  requestForUserWorker,
  tenantScriptNameFromUrl,
} from "./wfp_dispatch_worker.ts";
export { isValidTenantScriptName, TENANT_SCRIPT_NAME } from "./wfp_script_name.ts";
