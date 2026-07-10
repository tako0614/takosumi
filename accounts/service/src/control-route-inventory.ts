export type PublicSessionControlEndpointMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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
      path: "/api/v1/dashboard/bootstrap",
      summary: "Read the dashboard session bootstrap projection",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/dashboard/overview",
      summary: "Read the dashboard Workspace overview projection",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces",
      summary: "List caller Workspaces",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces",
      summary: "Create a Workspace",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}",
      summary: "Read a Workspace",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/workspaces/{workspaceId}",
      summary: "Update a Workspace",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/members",
      summary: "List Workspace members",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/{workspaceId}/members",
      summary: "Add a Workspace member",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/workspaces/{workspaceId}/members/{subject}",
      summary: "Change a Workspace member role",
      auth: "account-session",
    },
    {
      method: "DELETE",
      path: "/api/v1/workspaces/{workspaceId}/members/{subject}",
      summary: "Remove a Workspace member",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/capsules",
      summary: "List Workspace Capsules",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/current-state-versions",
      summary: "List current StateVersions for Workspace Capsules",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/{workspaceId}/capsules",
      summary: "Create a Capsule",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/graph",
      summary: "Read the Workspace Capsule dependency graph",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/runs",
      summary: "List Workspace Runs",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/activity",
      summary: "List Workspace Activity",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/backups",
      summary: "List Workspace Backups",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/{workspaceId}/backups",
      summary: "Create a Workspace Backup",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/{workspaceId}/backups/{backupId}/restores",
      summary: "Create a Restore Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/billing",
      summary: "Read owner account billing state for a Workspace route",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/usage",
      summary: "List Workspace usage",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/{workspaceId}/credit-reservations",
      summary: "List Workspace credit reservations",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/{workspaceId}/plan-update",
      summary: "Create a Workspace plan update Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/{workspaceId}/drift-check",
      summary: "Create a Workspace drift check Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsules/{capsuleId}",
      summary: "Read a Capsule",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/capsules/{capsuleId}",
      summary: "Update a Capsule",
      auth: "account-session",
    },
    {
      method: "DELETE",
      path: "/api/v1/capsules/{capsuleId}",
      summary: "Create a Capsule destroy plan",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/capsules/{capsuleId}/plan",
      summary: "Create a Capsule plan Run",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsules/{capsuleId}/usage-summary",
      summary: "Read the Capsule's showback usage aggregate",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/capsules/{capsuleId}/destroy-plan",
      summary: "Create a Capsule destroy plan Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/capsules/{capsuleId}/drift-check",
      summary: "Create a Capsule drift check Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/capsules/{capsuleId}/backups",
      summary: "Create a Capsule Backup",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsules/{capsuleId}/state-versions",
      summary: "List Capsule StateVersions",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsules/{capsuleId}/dependencies",
      summary: "List Capsule Dependencies",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/capsules/{capsuleId}/dependencies",
      summary: "Create a Capsule Dependency",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsules/{capsuleId}/provider-connections",
      summary: "Read Capsule ProviderBinding selections",
      auth: "account-session",
    },
    {
      method: "PUT",
      path: "/api/v1/capsules/{capsuleId}/provider-connections",
      summary: "Replace Capsule ProviderBinding selections",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsule-configs",
      summary: "List Capsule creation configs visible to the caller",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/capsule-configs/{capsuleConfigId}",
      summary: "Read a Capsule creation config",
      auth: "account-session",
    },
    {
      method: "PATCH",
      path: "/api/v1/capsule-configs/{capsuleConfigId}",
      summary: "Update a Capsule creation config",
      auth: "account-session",
    },
    {
      method: "GET",
      path: "/api/v1/providers",
      summary: "List provider connection recipes and policy metadata",
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
      path: "/api/v1/state-versions/{stateVersionId}",
      summary: "Read a StateVersion projection",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/state-versions/{stateVersionId}/rollback-plan",
      summary: "Create a StateVersion rollback plan",
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
      summary: "Read a grouped Run",
      auth: "account-session",
    },
    {
      method: "POST",
      path: "/api/v1/run-groups/{runGroupId}/approve",
      summary: "Approve a grouped Run",
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
      summary: "List ProviderConnections visible to a Workspace",
      auth: "account-session",
    },
  ] as const;
