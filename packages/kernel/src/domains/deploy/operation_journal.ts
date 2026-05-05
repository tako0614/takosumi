import { createHash } from "node:crypto";
import type { JsonObject } from "takosumi-contract";
import type { OperationPlanPreview } from "./operation_plan_preview.ts";

export type OperationJournalStage =
  | "prepare"
  | "pre-commit"
  | "commit"
  | "post-commit"
  | "observe"
  | "finalize"
  | "abort"
  | "skip";

export type OperationJournalPhase =
  | "apply"
  | "activate"
  | "destroy"
  | "rollback"
  | "recovery"
  | "observe";

export type OperationJournalStatus =
  | "recorded"
  | "succeeded"
  | "failed"
  | "skipped";

export interface OperationJournalEntry {
  readonly id: string;
  readonly spaceId: string;
  readonly deploymentName?: string;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly journalEntryId: string;
  readonly operationId: string;
  readonly phase: OperationJournalPhase;
  readonly stage: OperationJournalStage;
  readonly operationKind: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly effectDigest: `sha256:${string}`;
  readonly effect: JsonObject;
  readonly status: OperationJournalStatus;
  readonly createdAt: string;
}

export interface OperationJournalAppendInput {
  readonly spaceId: string;
  readonly deploymentName?: string;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly journalEntryId: string;
  readonly operationId: string;
  readonly phase: OperationJournalPhase;
  readonly stage: OperationJournalStage;
  readonly operationKind: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly effect: JsonObject;
  readonly status?: OperationJournalStatus;
  readonly createdAt: string;
}

export interface OperationJournalStore {
  /**
   * Append one stage record. Re-appending the same
   * `(spaceId, operationPlanDigest, journalEntryId, stage)` with the same
   * effect digest is idempotent. Re-appending it with a different effect
   * digest hard-fails so a retry cannot silently bind one WAL tuple to a
   * different side effect.
   */
  append(input: OperationJournalAppendInput): Promise<OperationJournalEntry>;
  listByPlan(
    spaceId: string,
    operationPlanDigest: `sha256:${string}`,
  ): Promise<readonly OperationJournalEntry[]>;
  listByDeployment(
    spaceId: string,
    deploymentName: string,
  ): Promise<readonly OperationJournalEntry[]>;
}

export class OperationJournalReplayMismatchError extends Error {
  readonly existing: OperationJournalEntry;
  readonly attemptedEffectDigest: `sha256:${string}`;

  constructor(input: {
    readonly existing: OperationJournalEntry;
    readonly attemptedEffectDigest: `sha256:${string}`;
  }) {
    super(
      "operation journal replay mismatch for " +
        `${input.existing.spaceId}/${input.existing.operationPlanDigest}/` +
        `${input.existing.journalEntryId}/${input.existing.stage}: ` +
        `existing=${input.existing.effectDigest} ` +
        `attempted=${input.attemptedEffectDigest}`,
    );
    this.name = "OperationJournalReplayMismatchError";
    this.existing = input.existing;
    this.attemptedEffectDigest = input.attemptedEffectDigest;
  }
}

export class InMemoryOperationJournalStore implements OperationJournalStore {
  readonly #entries = new Map<string, OperationJournalEntry>();
  readonly #idFactory: () => string;

  constructor(options: { readonly idFactory?: () => string } = {}) {
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  append(input: OperationJournalAppendInput): Promise<OperationJournalEntry> {
    const effectDigest = digest(input.effect);
    const key = entryKey(input);
    const existing = this.#entries.get(key);
    if (existing) {
      assertReplayCompatible(existing, effectDigest);
      return Promise.resolve(existing);
    }
    const entry = freezeClone(
      {
        id: this.#idFactory(),
        spaceId: input.spaceId,
        ...(input.deploymentName
          ? { deploymentName: input.deploymentName }
          : {}),
        operationPlanDigest: input.operationPlanDigest,
        journalEntryId: input.journalEntryId,
        operationId: input.operationId,
        phase: input.phase,
        stage: input.stage,
        operationKind: input.operationKind,
        ...(input.resourceName ? { resourceName: input.resourceName } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        effectDigest,
        effect: input.effect,
        status: input.status ?? "recorded",
        createdAt: input.createdAt,
      } satisfies OperationJournalEntry,
    );
    this.#entries.set(key, entry);
    return Promise.resolve(entry);
  }

  listByPlan(
    spaceId: string,
    operationPlanDigest: `sha256:${string}`,
  ): Promise<readonly OperationJournalEntry[]> {
    const entries = [...this.#entries.values()].filter((entry) =>
      entry.spaceId === spaceId &&
      entry.operationPlanDigest === operationPlanDigest
    );
    entries.sort(compareJournalEntries);
    return Promise.resolve(entries);
  }

  listByDeployment(
    spaceId: string,
    deploymentName: string,
  ): Promise<readonly OperationJournalEntry[]> {
    const entries = [...this.#entries.values()].filter((entry) =>
      entry.spaceId === spaceId && entry.deploymentName === deploymentName
    );
    entries.sort(compareJournalEntries);
    return Promise.resolve(entries);
  }
}

export async function appendOperationPlanJournalStages(input: {
  readonly store: OperationJournalStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly stages: readonly OperationJournalStage[];
  readonly status?: OperationJournalStatus;
  readonly createdAt: string;
  readonly detail?: JsonObject;
}): Promise<readonly OperationJournalEntry[]> {
  const entries: OperationJournalEntry[] = [];
  for (const operation of input.preview.operations) {
    for (const stage of input.stages) {
      entries.push(
        await input.store.append({
          spaceId: input.preview.spaceId,
          deploymentName: input.preview.deploymentName,
          operationPlanDigest: input.preview.operationPlanDigest,
          journalEntryId: operation.idempotencyKey.journalEntryId,
          operationId: operation.operationId,
          phase: input.phase,
          stage,
          operationKind: operation.op,
          resourceName: operation.resourceName,
          providerId: operation.providerId,
          effect: publicOperationEffect({
            planId: input.preview.planId,
            operationPlanDigest: input.preview.operationPlanDigest,
            desiredSnapshotDigest: input.preview.desiredSnapshotDigest,
            deploymentName: input.preview.deploymentName,
            phase: input.phase,
            stage,
            status: input.status ?? "recorded",
            operation: {
              operationId: operation.operationId,
              resourceName: operation.resourceName,
              shape: operation.shape,
              providerId: operation.providerId,
              op: operation.op,
              desiredDigest: operation.desiredDigest,
              dependsOn: [...operation.dependsOn],
            },
            detail: input.detail,
          }),
          status: input.status,
          createdAt: input.createdAt,
        }),
      );
    }
  }
  return entries;
}

function publicOperationEffect(input: {
  readonly planId: string;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly desiredSnapshotDigest: `sha256:${string}`;
  readonly deploymentName?: string;
  readonly phase: OperationJournalPhase;
  readonly stage: OperationJournalStage;
  readonly status: OperationJournalStatus;
  readonly operation: JsonObject;
  readonly detail?: JsonObject;
}): JsonObject {
  return stripUndefined({
    kind: "takosumi.public-operation-journal-effect@v1",
    planId: input.planId,
    deploymentName: input.deploymentName,
    operationPlanDigest: input.operationPlanDigest,
    desiredSnapshotDigest: input.desiredSnapshotDigest,
    phase: input.phase,
    stage: input.stage,
    status: input.status,
    operation: input.operation,
    detail: input.detail,
  });
}

export function operationJournalEffectDigest(
  effect: JsonObject,
): `sha256:${string}` {
  return digest(effect);
}

export function assertReplayCompatible(
  existing: OperationJournalEntry,
  attemptedEffectDigest: `sha256:${string}`,
): void {
  if (existing.effectDigest === attemptedEffectDigest) return;
  throw new OperationJournalReplayMismatchError({
    existing,
    attemptedEffectDigest,
  });
}

function entryKey(input: {
  readonly spaceId: string;
  readonly operationPlanDigest: string;
  readonly journalEntryId: string;
  readonly stage: string;
}): string {
  return [
    input.spaceId,
    input.operationPlanDigest,
    input.journalEntryId,
    input.stage,
  ].join("\u0000");
}

export function compareJournalEntries(
  left: OperationJournalEntry,
  right: OperationJournalEntry,
): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    stageRank(left.stage) - stageRank(right.stage) ||
    left.operationId.localeCompare(right.operationId);
}

function stageRank(stage: OperationJournalStage): number {
  switch (stage) {
    case "prepare":
      return 0;
    case "pre-commit":
      return 1;
    case "commit":
      return 2;
    case "post-commit":
      return 3;
    case "observe":
      return 4;
    case "finalize":
      return 5;
    case "abort":
      return 6;
    case "skip":
      return 7;
  }
}

function digest(value: unknown): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(canonicalize(value)));
  return `sha256:${hash.digest("hex")}`;
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

function stripUndefined(value: Record<string, unknown>): JsonObject {
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== undefined) output[key] = inner;
  }
  return output as JsonObject;
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
