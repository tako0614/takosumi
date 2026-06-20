export type PublicSessionControlEndpointMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export interface PublicSessionControlEndpoint {
  readonly method: PublicSessionControlEndpointMethod;
  readonly path: string;
  readonly summary: string;
  readonly auth: "account-session";
}

/**
 * Inventory for the account-plane session `/api/v1` control surface implemented
 * by `control-routes.ts`. The process `/openapi.json` describes internal
 * process families; this table keeps the public session route set reviewable
 * and lets docs/tests gate the separate session surface.
 */
export const PUBLIC_SESSION_CONTROL_ENDPOINTS: readonly PublicSessionControlEndpoint[] =
  [
    {
      method: "GET",
      path: "/api/v1/billing/plans",
      summary: "List public billing plans",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces",
      summary: "List caller spaces",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces",
      summary: "Create a Space",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/deploy",
      summary: "Deploy an uploaded local OpenTofu snapshot",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}",
      summary: "Read a Space",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/spaces/{spaceId}",
      summary: "Update a Space",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/members",
      summary: "List Space members",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/members",
      summary: "Add a Space member",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/spaces/{spaceId}/members/{subject}",
      summary: "Change a Space member role",
      auth: "account-session",
    },
    {
      method: "DELETE",
      path: "/api/v1/spaces/{spaceId}/members/{subject}",
      summary: "Remove a Space member",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/uploads",
      summary: "Upload a Space archive",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/installations",
      summary: "List Space Installations",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/installations",
      summary: "Create an Installation",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/graph",
      summary: "Read the Space dependency graph",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/activity",
      summary: "List Space Activity",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/backups",
      summary: "List Space Backups",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/backups",
      summary: "Create a Space Backup",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/backups/{backupId}/restores",
      summary: "Create a Restore Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/billing",
      summary: "Read Space billing state",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/usage",
      summary: "List Space usage",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/spaces/{spaceId}/credit-reservations",
      summary: "List Space credit reservations",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/plan-update",
      summary: "Create a Space plan update RunGroup",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/spaces/{spaceId}/drift-check",
      summary: "Create a Space drift check RunGroup",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/installations/{installationId}",
      summary: "Read an Installation",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/installations/{installationId}",
      summary: "Update an Installation",
      auth: "account-session",
    },
    {
      method: "DELETE",
      path: "/api/v1/installations/{installationId}",
      summary: "Create an Installation destroy plan",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/installations/{installationId}/plan",
      summary: "Create an Installation plan Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/installations/{installationId}/destroy-plan",
      summary: "Create an Installation destroy plan Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/installations/{installationId}/drift-check",
      summary: "Create an Installation drift check Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/installations/{installationId}/backups",
      summary: "Create an Installation Backup",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/installations/{installationId}/deployments",
      summary: "List Installation Deployments",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/installations/{installationId}/dependencies",
      summary: "List Installation Dependencies",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/installations/{installationId}/dependencies",
      summary: "Create an Installation Dependency",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/installations/{installationId}/provider-connections",
      summary: "Read Installation provider connection selections",
      auth: "account-session",
    },
    {
      method: "PUT",
      path: "/api/v1/installations/{installationId}/provider-connections",
      summary: "Replace Installation provider connection selections",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/install-configs",
      summary: "List InstallConfigs visible to the caller",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/install-configs/{installConfigId}",
      summary: "Read an InstallConfig",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/providers",
      summary: "List Provider Catalog entries",
      auth: "account-session",
    },
    {
      method: "DELETE",
      path: "/api/v1/dependencies/{dependencyId}",
      summary: "Delete a Dependency",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/sources",
      summary: "List Sources visible to the caller",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/sources",
      summary: "Create a Source",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/sources/{sourceId}",
      summary: "Read a Source",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/sources/{sourceId}",
      summary: "Update Source metadata",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/sources/{sourceId}/sync",
      summary: "Create a Source sync Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/sources/{sourceId}/snapshots",
      summary: "List SourceSnapshots",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/sources/{sourceId}/compatibility-check",
      summary: "Create a Compatibility Report",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/compatibility-reports/{reportId}",
      summary: "Read a Compatibility Report",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/deployments/{deploymentId}",
      summary: "Read a Deployment",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/deployments/{deploymentId}/rollback-plan",
      summary: "Create a Deployment rollback plan",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/runs/{runId}",
      summary: "Read a Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/runs/{runId}/approve",
      summary: "Approve a Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/runs/{runId}/apply",
      summary: "Apply a reviewed Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/runs/{runId}/logs",
      summary: "Read Run logs",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/runs/{runId}/events",
      summary: "Read Run events",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/runs/{runId}/cancel",
      summary: "Cancel a Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/runs/{runId}/cost",
      summary: "Read Run cost projection",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/run-groups/{runGroupId}",
      summary: "Read a RunGroup",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/run-groups/{runGroupId}/approve",
      summary: "Approve a RunGroup",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/connections",
      summary: "List Connections",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/connections",
      summary: "Create a write-only credential Connection",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/connections/{connectionId}/test",
      summary: "Verify a Connection",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/connections/{connectionId}/revoke",
      summary: "Revoke a Connection",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/connections/cloudflare/oauth/start",
      summary: "Start Cloudflare credential OAuth",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/connections/cloudflare/oauth/callback",
      summary: "Complete Cloudflare credential OAuth",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/output-shares",
      summary: "List OutputShares",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/output-shares",
      summary: "Create an OutputShare",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/output-shares/{shareId}/approve",
      summary: "Approve an OutputShare",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/output-shares/{shareId}/revoke",
      summary: "Revoke an OutputShare",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/provider-connections",
      summary: "List provider Connections visible to a Space",
      auth: "account-session",
    },
  ] as const;
