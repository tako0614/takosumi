/** Identities reserved before the install coordinator creates its Capsule. */
export function deterministicInitialCapsuleId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `cap_${suffix.padStart(16, "0")}`;
}

export function deterministicInstallSourceId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `src_${suffix.padStart(16, "0")}`;
}

/** Distinguishes an uncreated owner reservation from an arbitrary dangling owner. */
export function isInstallPlanSourceReservation(source: {
  readonly id: string;
  readonly ownerCapsuleId?: string;
  readonly createdByInstallPlanId?: string;
}): boolean {
  return !!source.createdByInstallPlanId &&
    source.id === deterministicInstallSourceId(source.createdByInstallPlanId) &&
    source.ownerCapsuleId === deterministicInitialCapsuleId(source.createdByInstallPlanId);
}
