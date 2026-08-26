import type { InstallConfig } from "takosumi-contract/install-configs";
import { installExperienceOidcClient } from "takosumi-contract";

import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";

export const OIDC_ACTIVATION_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * Value-free authority fence shared by Apply registration and live grant.
 * It binds the current immutable InstallConfig declaration to the Capsule's
 * execution epoch without persisting any module variable or secret value.
 */
export async function oidcClientActivationDigest(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly executionAuthorityEpoch: number;
  readonly installConfig: InstallConfig;
}): Promise<string> {
  if (
    !input.workspaceId ||
    !input.capsuleId ||
    !Number.isSafeInteger(input.executionAuthorityEpoch) ||
    input.executionAuthorityEpoch < 1
  ) {
    throw new TypeError("OIDC activation authority is invalid");
  }
  const profile = installExperienceOidcClient(
    input.installConfig.installExperience,
  );
  if (!profile) {
    throw new TypeError("OIDC activation profile is unavailable");
  }
  const [installConfigDigest, oidcProfileDigest] = await Promise.all([
    stableJsonDigest(input.installConfig),
    stableJsonDigest(profile),
  ]);
  return await stableJsonDigest({
    contract: "takosumi.accounts-oidc-activation/v1",
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    executionAuthorityEpoch: input.executionAuthorityEpoch,
    installConfigDigest,
    oidcProfileDigest,
  });
}
