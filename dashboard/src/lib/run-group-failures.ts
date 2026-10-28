export interface RunGroupFailure {
  readonly capsuleId: string;
  readonly reason: "dependency_retired";
}

/** Read recognized pre-plan failures from a RunGroup graph without trusting it. */
export function runGroupFailures(
  graphJson: unknown,
  existingCapsuleIds: Iterable<string> = [],
): RunGroupFailure[] {
  if (typeof graphJson !== "string") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(graphJson);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.failures)) return [];

  const existing = new Set(existingCapsuleIds);
  const failures: RunGroupFailure[] = [];
  for (const [capsuleId, reason] of Object.entries(parsed.failures)) {
    if (
      capsuleId.length === 0 || existing.has(capsuleId) ||
      reason !== "dependency_retired"
    ) {
      continue;
    }
    failures.push({ capsuleId, reason });
  }
  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
