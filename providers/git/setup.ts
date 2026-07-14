import type { GuidedConnectionRequestBuilder } from "../types.ts";
import { GuidedConnectionSetupError } from "../types.ts";
import { gitProviderSettings } from "./settings.ts";

function rejectFiles(
  input: Parameters<GuidedConnectionRequestBuilder>[0],
): void {
  if (input.files && input.files.length > 0) {
    throw new GuidedConnectionSetupError(
      "Git source credential setup does not accept credential files",
    );
  }
}

function sourceRequest(
  input: Parameters<GuidedConnectionRequestBuilder>[0],
  authMode: "https_token" | "ssh_key",
): ReturnType<GuidedConnectionRequestBuilder> {
  rejectFiles(input);
  const workspaceId = input.workspaceId;
  if (
    authMode === "ssh_key" &&
    !gitProviderSettings(input.scopeHints).knownHostsEntry
  ) {
    throw new GuidedConnectionSetupError(
      "scopeHints.providerSettings.knownHostsEntry is required for a Git SSH connection",
    );
  }
  return {
    ...(workspaceId ? { workspaceId } : {}),
    provider:
      authMode === "https_token"
        ? "source_git_https_token"
        : "source_git_ssh_key",
    kind:
      authMode === "https_token"
        ? "source_git_https_token"
        : "source_git_ssh_key",
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    values: input.values,
  };
}

export const buildGitHttpsTokenConnection: GuidedConnectionRequestBuilder = (
  input,
) => sourceRequest(input, "https_token");

export const buildGitSshKeyConnection: GuidedConnectionRequestBuilder = (
  input,
) => sourceRequest(input, "ssh_key");
