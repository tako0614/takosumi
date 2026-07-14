import type { GuidedConnectionRequestBuilder } from "../types.ts";
import { GuidedConnectionSetupError } from "../types.ts";

export const buildGenericEnvConnection: GuidedConnectionRequestBuilder =
  (input) => {
    const workspaceId = input.workspaceId;
    if (!input.provider?.trim()) {
      throw new GuidedConnectionSetupError(
        "provider is required for a generic env Provider Connection",
      );
    }
    if (!workspaceId) {
      throw new GuidedConnectionSetupError(
        "workspaceId is required for a generic env Provider Connection",
      );
    }
    if (input.scope !== undefined && input.scope !== "workspace") {
      throw new GuidedConnectionSetupError(
        "generic env Provider Connections are Workspace-scoped",
      );
    }
    return {
      workspaceId,
      provider: input.provider,
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
      },
      ...(input.displayName ? { displayName: input.displayName } : {}),
      scope: "workspace",
      ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      values: input.values,
      ...(input.files ? { files: input.files } : {}),
    };
  };
