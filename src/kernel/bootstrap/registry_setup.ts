import { registerBundledArtifactKinds } from "./artifact_kinds.ts";

let artifactKindsRegistered = false;

/**
 * Idempotently registers artifact kind metadata used by the current artifact
 * routes. Component kind descriptors and providers are operator-supplied and
 * are not registered by the Takosumi kernel.
 */
export function registerDefaultArtifactKinds(): void {
  if (artifactKindsRegistered) return;
  registerBundledArtifactKinds();
  artifactKindsRegistered = true;
}
