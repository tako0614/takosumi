import { createHash } from "node:crypto";
import type { JsonObject } from "takosumi-contract";

export type RevokeDebtReason =
  | "external-revoke"
  | "link-revoke"
  | "activation-rollback"
  | "approval-invalidated"
  | "cross-space-share-expired";

export type RevokeDebtStatus =
  | "open"
  | "operator-action-required"
  | "cleared";

export interface RevokeDebtRecord {
  readonly id: string;
  readonly sourceKey: `sha256:${string}`;
  readonly generatedObjectId: string;
  readonly sourceExportSnapshotId?: string;
  readonly externalParticipantId?: string;
  readonly reason: RevokeDebtReason;
  readonly status: RevokeDebtStatus;
  readonly ownerSpaceId: string;
  readonly originatingSpaceId: string;
  readonly deploymentName?: string;
  readonly operationPlanDigest?: `sha256:${string}`;
  readonly journalEntryId?: string;
  readonly operationId?: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly retryPolicy: JsonObject;
  readonly retryAttempts: number;
  readonly lastRetryAt?: string;
  readonly nextRetryAt?: string;
  readonly lastRetryError?: JsonObject;
  readonly detail?: JsonObject;
  readonly createdAt: string;
  readonly statusUpdatedAt: string;
  readonly agedAt?: string;
  readonly clearedAt?: string;
}

export interface RevokeDebtEnqueueInput {
  readonly generatedObjectId: string;
  readonly sourceExportSnapshotId?: string;
  readonly externalParticipantId?: string;
  readonly reason: RevokeDebtReason;
  readonly ownerSpaceId: string;
  readonly originatingSpaceId?: string;
  readonly deploymentName?: string;
  readonly operationPlanDigest?: `sha256:${string}`;
  readonly journalEntryId?: string;
  readonly operationId?: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly retryPolicy?: JsonObject;
  readonly detail?: JsonObject;
  readonly now: string;
}

export interface RevokeDebtTransitionInput {
  readonly id: string;
  readonly ownerSpaceId: string;
  readonly now: string;
}

export interface RevokeDebtAgeOpenInput {
  readonly ownerSpaceId: string;
  readonly now: string;
  readonly limit?: number;
}

export type RevokeDebtRetryAttemptResult =
  | "cleared"
  | "retryable-failure"
  | "blocked";

export interface RevokeDebtRetryAttemptInput extends RevokeDebtTransitionInput {
  readonly result: RevokeDebtRetryAttemptResult;
  readonly error?: JsonObject;
  readonly nextRetryAt?: string;
}

export interface RevokeDebtStore {
  /**
   * Enqueue a debt idempotently. Repeating the same source tuple returns the
   * existing row instead of creating duplicate cleanup obligations.
   */
  enqueue(input: RevokeDebtEnqueueInput): Promise<RevokeDebtRecord>;
  listByOwnerSpace(
    ownerSpaceId: string,
  ): Promise<readonly RevokeDebtRecord[]>;
  listByDeployment(
    ownerSpaceId: string,
    deploymentName: string,
  ): Promise<readonly RevokeDebtRecord[]>;
  /**
   * Return owner Spaces that still have open cleanup obligations. Daemon
   * schedulers use this to avoid relying on a static Space list.
   */
  listOpenOwnerSpaces(): Promise<readonly string[]>;
  /**
   * Record one cleanup retry attempt. Retryable failures keep the debt open
   * until retryPolicy.maxAttempts is exhausted; cleared and blocked outcomes
   * move to terminal/operator states.
   */
  recordRetryAttempt(
    input: RevokeDebtRetryAttemptInput,
  ): Promise<RevokeDebtRecord | undefined>;
  /**
   * Move open debts whose policy-controlled aging window has elapsed to
   * operator-action-required. Policies without a concrete aging window are left
   * open for an external policy engine to drive.
   */
  ageOpenDebts(
    input: RevokeDebtAgeOpenInput,
  ): Promise<readonly RevokeDebtRecord[]>;
  markOperatorActionRequired(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined>;
  reopen(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined>;
  clear(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined>;
}

export class InMemoryRevokeDebtStore implements RevokeDebtStore {
  readonly #rows = new Map<string, RevokeDebtRecord>();
  readonly #idFactory: () => string;

  constructor(options: { readonly idFactory?: () => string } = {}) {
    this.#idFactory = options.idFactory ??
      (() => `revoke-debt:${crypto.randomUUID()}`);
  }

  enqueue(input: RevokeDebtEnqueueInput): Promise<RevokeDebtRecord> {
    const sourceKey = revokeDebtSourceKey(input);
    const existing = this.#rows.get(sourceKey);
    if (existing) return Promise.resolve(existing);
    const record = freezeClone(
      {
        id: this.#idFactory(),
        sourceKey,
        generatedObjectId: input.generatedObjectId,
        ...(input.sourceExportSnapshotId
          ? { sourceExportSnapshotId: input.sourceExportSnapshotId }
          : {}),
        ...(input.externalParticipantId
          ? { externalParticipantId: input.externalParticipantId }
          : {}),
        reason: input.reason,
        status: "open" as const,
        ownerSpaceId: input.ownerSpaceId,
        originatingSpaceId: input.originatingSpaceId ?? input.ownerSpaceId,
        ...(input.deploymentName
          ? { deploymentName: input.deploymentName }
          : {}),
        ...(input.operationPlanDigest
          ? { operationPlanDigest: input.operationPlanDigest }
          : {}),
        ...(input.journalEntryId
          ? { journalEntryId: input.journalEntryId }
          : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.resourceName ? { resourceName: input.resourceName } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        retryPolicy: input.retryPolicy ?? defaultRetryPolicy(),
        retryAttempts: 0,
        nextRetryAt: input.now,
        ...(input.detail ? { detail: input.detail } : {}),
        createdAt: input.now,
        statusUpdatedAt: input.now,
      } satisfies RevokeDebtRecord,
    );
    this.#rows.set(sourceKey, record);
    return Promise.resolve(record);
  }

  listByOwnerSpace(
    ownerSpaceId: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    return Promise.resolve(
      [...this.#rows.values()]
        .filter((row) => row.ownerSpaceId === ownerSpaceId)
        .sort(compareRevokeDebtRecords),
    );
  }

  listByDeployment(
    ownerSpaceId: string,
    deploymentName: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    return Promise.resolve(
      [...this.#rows.values()]
        .filter((row) =>
          row.ownerSpaceId === ownerSpaceId &&
          row.deploymentName === deploymentName
        )
        .sort(compareRevokeDebtRecords),
    );
  }

  listOpenOwnerSpaces(): Promise<readonly string[]> {
    return Promise.resolve(
      Array.from(
        new Set(
          Array.from(this.#rows.values())
            .filter((record) => record.status === "open")
            .map((record) => record.ownerSpaceId),
        ),
      ).sort(),
    );
  }

  recordRetryAttempt(
    input: RevokeDebtRetryAttemptInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = this.#getOwned(input);
    if (!existing) return Promise.resolve(undefined);
    const next = recordRevokeDebtRetryAttempt(existing, input);
    this.#replace(next);
    return Promise.resolve(next);
  }

  ageOpenDebts(
    input: RevokeDebtAgeOpenInput,
  ): Promise<readonly RevokeDebtRecord[]> {
    const aged: RevokeDebtRecord[] = [];
    const candidates = [...this.#rows.values()]
      .filter((row) => row.ownerSpaceId === input.ownerSpaceId)
      .sort(compareRevokeDebtRecords);
    for (const record of candidates) {
      if (input.limit !== undefined && aged.length >= input.limit) break;
      const next = ageRevokeDebtIfDue(record, input.now);
      if (!next) continue;
      this.#replace(next);
      aged.push(next);
    }
    return Promise.resolve(aged);
  }

  markOperatorActionRequired(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = this.#getOwned(input);
    if (!existing) return Promise.resolve(undefined);
    const next = markRevokeDebtOperatorActionRequired(existing, input.now);
    this.#replace(next);
    return Promise.resolve(next);
  }

  reopen(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = this.#getOwned(input);
    if (!existing) return Promise.resolve(undefined);
    const next = reopenRevokeDebt(existing, input.now);
    this.#replace(next);
    return Promise.resolve(next);
  }

  clear(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = this.#getOwned(input);
    if (!existing) return Promise.resolve(undefined);
    const next = clearRevokeDebt(existing, input.now);
    this.#replace(next);
    return Promise.resolve(next);
  }

  #getOwned(input: {
    readonly id: string;
    readonly ownerSpaceId: string;
  }): RevokeDebtRecord | undefined {
    const record = [...this.#rows.values()].find((row) =>
      row.id === input.id && row.ownerSpaceId === input.ownerSpaceId
    );
    return record;
  }

  #replace(record: RevokeDebtRecord): void {
    this.#rows.set(record.sourceKey, record);
  }
}

export function summarizeRevokeDebt(
  records: readonly RevokeDebtRecord[],
): RevokeDebtSummary {
  return {
    total: records.length,
    open: records.filter((record) => record.status === "open").length,
    operatorActionRequired:
      records.filter((record) => record.status === "operator-action-required")
        .length,
    cleared: records.filter((record) => record.status === "cleared").length,
  };
}

export interface RevokeDebtSummary {
  readonly total: number;
  readonly open: number;
  readonly operatorActionRequired: number;
  readonly cleared: number;
}

export function revokeDebtSourceKey(
  input: RevokeDebtEnqueueInput,
): `sha256:${string}` {
  return digest({
    ownerSpaceId: input.ownerSpaceId,
    reason: input.reason,
    generatedObjectId: input.generatedObjectId,
    operationPlanDigest: input.operationPlanDigest,
    journalEntryId: input.journalEntryId,
    sourceExportSnapshotId: input.sourceExportSnapshotId,
    externalParticipantId: input.externalParticipantId,
  });
}

export function defaultRetryPolicy(): JsonObject {
  return {
    kind: "operator-managed",
    agingWindow: "policy-controlled",
  };
}

export function recordRevokeDebtRetryAttempt(
  record: RevokeDebtRecord,
  input: RevokeDebtRetryAttemptInput,
): RevokeDebtRecord {
  if (record.status === "cleared") return record;
  if (record.status === "operator-action-required") return record;

  const retryAttempts = record.retryAttempts + 1;
  if (input.result === "cleared") {
    return recordWith(record, {
      status: "cleared",
      retryAttempts,
      lastRetryAt: input.now,
      nextRetryAt: undefined,
      lastRetryError: undefined,
      statusUpdatedAt: input.now,
      clearedAt: record.clearedAt ?? input.now,
    });
  }

  const exhausted = input.result === "retryable-failure" &&
    retryAttemptsExhausted(record.retryPolicy, retryAttempts);
  if (input.result === "blocked" || exhausted) {
    return recordWith(record, {
      status: "operator-action-required",
      retryAttempts,
      lastRetryAt: input.now,
      nextRetryAt: undefined,
      lastRetryError: input.error,
      statusUpdatedAt: input.now,
      agedAt: record.agedAt ?? input.now,
    });
  }

  return recordWith(record, {
    retryAttempts,
    lastRetryAt: input.now,
    nextRetryAt: input.nextRetryAt ??
      nextRetryAt(record.retryPolicy, input.now),
    lastRetryError: input.error,
  });
}

export function ageRevokeDebtIfDue(
  record: RevokeDebtRecord,
  now: string,
): RevokeDebtRecord | undefined {
  if (record.status !== "open") return undefined;
  const windowMs = agingWindowMs(record.retryPolicy);
  if (windowMs === undefined) return undefined;
  const baseTime = Date.parse(record.statusUpdatedAt);
  const nowTime = Date.parse(now);
  if (!Number.isFinite(baseTime) || !Number.isFinite(nowTime)) {
    return undefined;
  }
  if (nowTime - baseTime < windowMs) return undefined;
  return markRevokeDebtOperatorActionRequired(record, now);
}

export function markRevokeDebtOperatorActionRequired(
  record: RevokeDebtRecord,
  now: string,
): RevokeDebtRecord {
  if (record.status === "cleared") return record;
  if (record.status === "operator-action-required") return record;
  return recordWith(record, {
    status: "operator-action-required",
    nextRetryAt: undefined,
    statusUpdatedAt: now,
    agedAt: record.agedAt ?? now,
  });
}

export function reopenRevokeDebt(
  record: RevokeDebtRecord,
  now: string,
): RevokeDebtRecord {
  if (record.status === "cleared") return record;
  if (record.status === "open") return record;
  return recordWith(record, {
    status: "open",
    nextRetryAt: now,
    statusUpdatedAt: now,
  });
}

export function clearRevokeDebt(
  record: RevokeDebtRecord,
  now: string,
): RevokeDebtRecord {
  if (record.status === "cleared") return record;
  return recordWith(record, {
    status: "cleared",
    nextRetryAt: undefined,
    lastRetryError: undefined,
    statusUpdatedAt: now,
    clearedAt: record.clearedAt ?? now,
  });
}

export function compareRevokeDebtRecords(
  left: RevokeDebtRecord,
  right: RevokeDebtRecord,
): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}

function digest(value: unknown): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(canonicalize(value)));
  return `sha256:${hash.digest("hex")}`;
}

function retryAttemptsExhausted(
  retryPolicy: JsonObject,
  attempts: number,
): boolean {
  const maxAttempts = positiveInteger(retryPolicy.maxAttempts);
  return maxAttempts !== undefined && attempts >= maxAttempts;
}

function nextRetryAt(
  retryPolicy: JsonObject,
  now: string,
): string | undefined {
  const backoffMs = durationMsFromPolicy(retryPolicy, [
    "backoffMs",
    "retryBackoffMs",
  ]) ?? secondsToMs(positiveNumber(retryPolicy.backoffSeconds)) ??
    secondsToMs(positiveNumber(retryPolicy.retryBackoffSeconds));
  if (backoffMs === undefined) return undefined;
  return new Date(Date.parse(now) + backoffMs).toISOString();
}

function agingWindowMs(retryPolicy: JsonObject): number | undefined {
  return durationMsFromPolicy(retryPolicy, ["agingWindowMs"]) ??
    secondsToMs(positiveNumber(retryPolicy.agingWindowSeconds)) ??
    isoDurationMs(stringValue(retryPolicy.agingWindow));
}

function durationMsFromPolicy(
  retryPolicy: JsonObject,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = positiveNumber(retryPolicy[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function secondsToMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}

function positiveInteger(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isoDurationMs(value: string | undefined): number | undefined {
  if (!value || value === "policy-controlled") return undefined;
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return total > 0 ? total : undefined;
}

function recordWith(
  record: RevokeDebtRecord,
  updates: Partial<RevokeDebtRecord>,
): RevokeDebtRecord {
  const next = { ...record, ...updates } as Record<string, unknown>;
  for (
    const key of [
      "lastRetryAt",
      "nextRetryAt",
      "lastRetryError",
      "agedAt",
      "clearedAt",
    ]
  ) {
    if (next[key] === undefined) delete next[key];
  }
  return freezeClone(next as unknown as RevokeDebtRecord);
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const canonical = canonicalize(object[key]);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  }
  return value;
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
