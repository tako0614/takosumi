import type { GuidedConnectionRequestBuilder } from "../types.ts";
import { GuidedConnectionSetupError } from "../types.ts";
import { awsProviderSettings } from "./settings.ts";

export const buildAwsAssumeRoleConnection: GuidedConnectionRequestBuilder = (
  input,
) => {
  if (input.files && input.files.length > 0) {
    throw new GuidedConnectionSetupError(
      "aws/assume-role does not accept credential files",
    );
  }
  const settings = awsProviderSettings(input.scopeHints);
  const roleArn = settings.roleArn;
  if (!roleArn) {
    throw new GuidedConnectionSetupError(
      "scopeHints.providerSettings.roleArn is required for an aws assume-role connection",
    );
  }
  const values = {
    ...input.values,
    ...(input.values.AWS_ROLE_ARN === undefined
      ? { AWS_ROLE_ARN: roleArn }
      : {}),
    ...(settings.region &&
    input.values.AWS_REGION === undefined &&
    input.values.AWS_DEFAULT_REGION === undefined
      ? { AWS_REGION: settings.region }
      : {}),
  };
  const workspaceId = input.workspaceId;
  return {
    ...(workspaceId ? { workspaceId } : {}),
    provider: "registry.opentofu.org/hashicorp/aws",
    credentialRecipe: {
      id: "aws",
      authMode: "assume_role",
      secretPartition: "provider-credentials",
    },
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    values,
  };
};
