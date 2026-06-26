/**
 * Core condition reason catalog. Single-source-of-truth via `as const`; the type
 * union and the runtime list are derived together.
 *
 * Relocated from the retired `takosumi-v1.ts` reference umbrella.
 */

export const CORE_CONDITION_REASONS = [
  "PlanStale", "ReadSetChanged",
  "DescriptorPinned", "DescriptorChanged", "DescriptorUnavailable", "DescriptorUntrusted",
  "DescriptorCompatibilityUnknown", "DescriptorAliasAmbiguous", "DescriptorContextChanged",
  "DescriptorBootstrapTrustMissing", "ResolvedGraphChanged", "PolicyDenied",
  "ApprovalRequired", "ApprovalMissing", "ApprovalInvalidated", "BreakGlassRequired",
  "BreakGlassDenied", "BindingCollision", "BindingResolutionFailed", "BindingTargetUnsupported",
  "BindingRebindRequired", "BindingSourceWithdrawn", "BindingSourceUnavailable",
  "InjectionModeUnsupported", "AccessModeUnsupported", "SecretResolutionFailed",
  "SecretVersionRevoked", "CredentialVisibilityUnsupported", "CredentialRawEnvDenied",
  "CredentialOutputRequiresApproval", "RawCredentialInjectionDenied",
  "AccessPathUnsupported", "AccessPathAmbiguous", "AccessPathMaterializationFailed",
  "AccessPathExternalBoundaryRequiresPolicy", "AccessPathCredentialBoundaryFailed",
  "ResourceCompatibilityFailed", "ResourceBindingFailed", "ResourceRestoreUnsupported",
  "ResourceRebindRequired", "ActivationCommitted", "ActivationPreviewFailed",
  "ActivationAssignmentInvalid", "ActivationPrimaryMissing", "RouterConfigIncompatible",
  "RouteDescriptorIncompatible", "InterfaceDescriptorIncompatible", "RouterAssignmentUnsupported", "RouterProtocolUnsupported",
  "ServingMaterializing", "ServingConverged", "ServingDegraded", "ServingConvergenceUnknown",
  "ProviderMaterializing", "ProviderMaterializationFailed", "ProviderObjectMissing",
  "ProviderConfigDrift", "ProviderStatusDrift", "ProviderSecurityDrift",
  "ProviderOwnershipDrift", "ProviderCacheDrift", "ProviderRateLimited",
  "ProviderCredentialDenied", "ProviderPartialSuccess", "ProviderOperationTimedOut",
  "OutputWithdrawn", "OutputUnavailable", "OutputResolutionFailed",
  "OutputProjectionFailed", "OutputRouteUnavailable", "OutputAuthUnavailable",
  "OutputConsumerRebindRequired", "OutputConsumerGrantMissing",
  "OutputInjectionDenied",
  "RollbackIncompatible", "RollbackDescriptorUnavailable",
  "RollbackArtifactUnavailable", "RollbackResourceIncompatible", "RepairPlanRequired",
  "RepairMaterializationRequired", "RepairAccessPathRequired",
  "RepairOutputProjectionRequired",
  "ArtifactUnavailable", "ArtifactRetentionMissing",
  "RuntimeNotReady", "RuntimeReadinessUnknown", "RuntimeLiveRebindUnsupported",
  "RuntimeShutdownFailed", "RuntimeDrainTimeout",
] as const;

export type CoreConditionReason = typeof CORE_CONDITION_REASONS[number];

const CORE_CONDITION_REASON_SET: ReadonlySet<string> = new Set(
  CORE_CONDITION_REASONS,
);

export function isCoreConditionReason(
  value: unknown,
): value is CoreConditionReason {
  return typeof value === "string" && CORE_CONDITION_REASON_SET.has(value);
}
