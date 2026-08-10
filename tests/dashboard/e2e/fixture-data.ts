/**
 * Small, deterministic data set for the portable dashboard browser check.
 *
 * The fixture is intentionally shaped like the public dashboard projections,
 * not like an internal store/database row. It proves that the browser can
 * authenticate, navigate, switch Workspace scope, and render the canonical
 * launcher projection without deploying anything.
 */

const CREATED_AT = "2026-08-01T00:00:00.000Z";

export const PORTABLE_SESSION_COOKIE = "takosumi_session=portable-e2e";

export const PORTABLE_EXPECTATIONS = {
  workspaceName: "Alpha Workspace",
  switchWorkspaceName: "Beta Workspace",
  duplicateWorkspaceHandle: "alpha-lab",
  appName: "Repository Office",
  appUrl: "https://apps.example.test/repository-office",
} as const;

export const PORTABLE_WORKSPACES = [
  {
    id: "ws_alpha",
    handle: "alpha",
    displayName: PORTABLE_EXPECTATIONS.workspaceName,
    type: "personal",
    ownerUserId: "sub_portable_e2e",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-01T00:00:02.000Z",
  },
  {
    id: "ws_beta",
    handle: "beta",
    displayName: PORTABLE_EXPECTATIONS.switchWorkspaceName,
    type: "personal",
    ownerUserId: "sub_portable_e2e",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-01T00:00:01.000Z",
  },
  {
    id: "ws_alpha_lab",
    handle: PORTABLE_EXPECTATIONS.duplicateWorkspaceHandle,
    displayName: PORTABLE_EXPECTATIONS.workspaceName,
    type: "personal",
    ownerUserId: "sub_portable_e2e",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-01T00:00:00.500Z",
  },
] as const;

function capsule(workspaceId: string, id: string, name: string) {
  return {
    id,
    workspaceId,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
    sourceId: `src_${id}`,
    installConfigId: `cfg_${id}`,
    environment: "production",
    currentStateGeneration: 1,
    status: "active",
    freshness: "fresh",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export const PORTABLE_CAPSULES = {
  ws_alpha: [
    capsule("ws_alpha", "cap_repository_office", PORTABLE_EXPECTATIONS.appName),
  ],
  ws_beta: [capsule("ws_beta", "cap_beta_office", "Beta Office")],
} as const;

function launcherInterface(
  workspaceId: string,
  capsuleId: string,
  title: string,
  url: string,
) {
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: `if_${capsuleId}`,
      workspaceId,
      name: "app.launcher",
      ownerRef: { kind: "Capsule", id: capsuleId },
      generation: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: {
        launcher: true,
        display: { title, category: "productivity" },
      },
      inputs: {
        url: {
          source: "capsule_output",
          capsuleId,
          outputName: "url",
        },
      },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { url },
    },
  };
}

export const PORTABLE_UI_SURFACES = {
  ws_alpha: [
    launcherInterface(
      "ws_alpha",
      "cap_repository_office",
      PORTABLE_EXPECTATIONS.appName,
      PORTABLE_EXPECTATIONS.appUrl,
    ),
  ],
  ws_beta: [
    launcherInterface(
      "ws_beta",
      "cap_beta_office",
      "Beta Office",
      "https://apps.example.test/beta-office",
    ),
  ],
} as const;

export function workspacesResponse() {
  return {
    workspaces: PORTABLE_WORKSPACES,
    total: PORTABLE_WORKSPACES.length,
    returned: PORTABLE_WORKSPACES.length,
    limit: 50,
    truncated: false,
  };
}
