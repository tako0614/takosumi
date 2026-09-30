/** The only native state fields needed for OpenTofu's saved-plan stale fence. */
export interface OpenTofuStateMetadata {
  readonly lineage: string;
  readonly serial: number;
}

export const ABSENT_OPENTOFU_STATE_METADATA: OpenTofuStateMetadata = {
  lineage: "",
  serial: 0,
};

/** Never include state JSON or parsed values in an error: it can contain secrets. */
export function parseOpenTofuStateMetadata(
  bytes: Uint8Array,
): OpenTofuStateMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("OpenTofu state metadata is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).lineage !== "string" ||
    !Number.isSafeInteger((parsed as Record<string, unknown>).serial) ||
    ((parsed as Record<string, unknown>).serial as number) < 0
  ) {
    throw new Error("OpenTofu state metadata is invalid");
  }
  return {
    lineage: (parsed as Record<string, unknown>).lineage as string,
    serial: (parsed as Record<string, unknown>).serial as number,
  };
}

/** Mirrors backend_local's first-plan and exact serial/lineage checks. */
export function assertSavedPlanMatchesState(
  plan: OpenTofuStateMetadata,
  current: OpenTofuStateMetadata,
): void {
  const firstPlan = plan.lineage === "" && plan.serial === 0;
  if ((!firstPlan && plan.lineage !== current.lineage) ||
      plan.serial !== current.serial) {
    throw new Error("OpenTofu saved Plan is stale against canonical state");
  }
}
