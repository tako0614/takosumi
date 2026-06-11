/**
 * Workers-for-Platforms tenant script name = the dispatch routing key.
 *
 * One source of truth for the rule, shared by:
 *  - the WfP ingress dispatcher (`providers/cloudflare/hosting/wfp_dispatch_worker.ts`), which
 *    routes a request to `env.TAKOSUMI_TENANT_DISPATCH.get(scriptName)` by the
 *    first URL path segment, and
 *  - the control plane (`deploy-control/mod.ts`), which validates the minted
 *    script name (the Installation slug) against this BEFORE a managed Worker is
 *    published into the dispatch namespace.
 *
 * A 1-63 char DNS-style label: lowercase alphanumerics and internal hyphens.
 */
export const TENANT_SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidTenantScriptName(name: string): boolean {
  return TENANT_SCRIPT_NAME.test(name);
}
