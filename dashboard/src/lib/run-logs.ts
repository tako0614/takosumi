/**
 * Best-effort extraction of human-relevant facts from Run logs / audit events.
 * Moved out of the run view so the Installation detail's recent-runs strip can reuse it.
 * All of this is display-only: it reads whatever shape the backend recorded
 * and degrades to "nothing detected" rather than guessing.
 */
import type { Run, RunAuditEvent } from "./control-api.ts";

export type AuditEventRecord = RunAuditEvent & {
  readonly inputs?: unknown;
  readonly injectedInputs?: unknown;
  readonly variables?: unknown;
  readonly resourceChanges?: unknown;
  readonly changes?: unknown;
  readonly planChanges?: unknown;
  readonly changeSummary?: unknown;
  readonly connections?: unknown;
  readonly resolvedConnections?: unknown;
  readonly bindings?: unknown;
};

export interface ChangeItem {
  readonly action: "create" | "update" | "delete";
  readonly label: string;
}

/** A Run is terminal once it has reached a final status. */
export function isTerminalRunStatus(status: Run["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

/** Dependency-injected input names from audit events. */
export function inputNamesFromLogs(
  auditEvents: readonly AuditEventRecord[],
): readonly string[] {
  const names = new Set<string>();
  for (const event of auditEvents) {
    const detail = auditEventDetail(event);
    const inputs = detail.inputs ?? detail.injectedInputs ?? detail.variables;
    if (Array.isArray(inputs)) {
      for (const i of inputs) if (typeof i === "string") names.add(i);
    } else if (inputs && typeof inputs === "object") {
      for (const k of Object.keys(inputs)) names.add(k);
    }
  }
  return [...names];
}

/** Resource changes (create/update/delete) recorded in the run logs. */
export function changesFromLogs(
  auditEvents: readonly AuditEventRecord[],
): readonly ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const event of auditEvents) {
    const detail = auditEventDetail(event);
    const candidates = [
      detail.resourceChanges,
      detail.changes,
      detail.planChanges,
      detail.changeSummary,
    ];
    for (const candidate of candidates) {
      collectChanges(candidate, out);
    }
  }
  return out;
}

function collectChanges(candidate: unknown, out: ChangeItem[]): void {
  if (!candidate) return;
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === "string") {
        out.push({ action: "update", label: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const action = normalizeAction(
        record.action ?? record.change ?? record.op,
      );
      const label = String(
        record.address ?? record.resource ?? record.name ?? record.type ?? "",
      );
      if (action && label) out.push({ action, label });
    }
    return;
  }
  if (typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    for (const action of ["create", "update", "delete"] as const) {
      const list = record[action];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const label =
          typeof item === "string"
            ? item
            : item && typeof item === "object"
              ? String(
                  (item as Record<string, unknown>).address ??
                    (item as Record<string, unknown>).name ??
                    "",
                )
              : "";
        if (label) out.push({ action, label });
      }
    }
  }
}

function normalizeAction(value: unknown): ChangeItem["action"] | undefined {
  if (Array.isArray(value)) {
    if (value.includes("delete")) return "delete";
    if (value.includes("create")) return "create";
    if (value.includes("update")) return "update";
  }
  if (value === "create" || value === "update" || value === "delete") {
    return value;
  }
  return undefined;
}

/** Resolved provider-connection descriptions recorded in the run logs. */
export function connectionNamesFromLogs(
  auditEvents: readonly AuditEventRecord[],
): readonly string[] {
  const names = new Set<string>();
  for (const event of auditEvents) {
    const detail = auditEventDetail(event);
    const connections =
      detail.connections ?? detail.resolvedConnections ?? detail.bindings;
    if (Array.isArray(connections)) {
      for (const item of connections) {
        if (typeof item === "string") names.add(item);
        else if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const providerLabel =
            typeof record.provider === "string" && record.provider.length > 0
              ? typeof record.alias === "string" && record.alias.length > 0
                ? `${record.provider}.${record.alias}`
                : record.provider
              : undefined;
          const label = providerLabel
            ? `${providerLabel}: ${record.mode ?? record.connectionId ?? "default"}`
            : (record.connectionId ?? record.id);
          if (typeof label === "string") names.add(label);
        }
      }
    } else if (connections && typeof connections === "object") {
      for (const [provider, value] of Object.entries(connections)) {
        if (typeof value === "string") names.add(`${provider}: ${value}`);
        else if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          names.add(
            `${provider}: ${record.mode ?? record.connectionId ?? "default"}`,
          );
        }
      }
    }
  }
  return [...names];
}

function auditEventDetail(event: AuditEventRecord): Record<string, unknown> {
  if (isRecord(event.detail)) return event.detail;
  if (isRecord(event.data)) return event.data;
  if (isRecord(event.metadata)) return event.metadata;
  return event as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
