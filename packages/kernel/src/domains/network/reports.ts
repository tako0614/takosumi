import type {
  EgressReport,
  EgressReportEntry,
  EgressReportSummary,
} from "./types.ts";

export interface BuildEgressReportInput {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly generatedAt?: string;
  readonly entries: readonly EgressReportEntry[];
}

export function buildEgressReport(input: BuildEgressReportInput): EgressReport {
  return Object.freeze({
    id: input.id,
    spaceId: input.spaceId,
    groupId: input.groupId,
    activationId: input.activationId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    entries: input.entries.map((entry) => Object.freeze({ ...entry })),
    summary: summarizeEgress(input.entries),
  });
}

export function summarizeEgress(
  entries: readonly EgressReportEntry[],
): EgressReportSummary {
  return entries.reduce<EgressReportSummary>(
    (summary, entry) => ({
      allowedCount: summary.allowedCount +
        (entry.decision === "allowed" ? 1 : 0),
      deniedCount: summary.deniedCount + (entry.decision === "denied" ? 1 : 0),
      unknownCount: summary.unknownCount +
        (entry.decision === "unknown" ? 1 : 0),
      bytesSent: summary.bytesSent + (entry.bytesSent ?? 0),
      bytesReceived: summary.bytesReceived + (entry.bytesReceived ?? 0),
    }),
    {
      allowedCount: 0,
      deniedCount: 0,
      unknownCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
    },
  );
}
