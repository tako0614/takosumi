import type { JsonObject } from "takosumi-contract";
import type {
  MigrationCheckpoint,
  MigrationLedgerEntry,
  ResourceInstanceId,
} from "../../domains/resources/mod.ts";
import { conflict } from "../../shared/errors.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

export interface MigrationCheckpointInput {
  readonly name: string;
  readonly checksum?: string;
  readonly metadata?: JsonObject;
}

export interface ValidateMigrationInput {
  readonly resourceInstanceId: ResourceInstanceId;
  readonly migrationRef: string;
  readonly checksum?: string;
  readonly checkpoints?: readonly MigrationCheckpointInput[];
}

export function toLedgerCheckpoints(
  checkpoints: readonly MigrationCheckpointInput[],
  recordedAt: IsoTimestamp,
): readonly MigrationCheckpoint[] {
  return checkpoints.map((checkpoint) => ({
    name: checkpoint.name,
    checksum: checkpoint.checksum,
    metadata: checkpoint.metadata,
    recordedAt,
  }));
}

export function withMigrationChecksum(
  metadata: JsonObject | undefined,
  checksum: string | undefined,
): JsonObject | undefined {
  if (!checksum) return metadata;
  return { ...(metadata ?? {}), checksum };
}

export function assertMigrationChecksumUnchanged(
  entry: MigrationLedgerEntry,
  input: ValidateMigrationInput,
): void {
  const existingChecksum = stringValue(entry.metadata?.checksum) ??
    stringValue(entry.metadata?.migrationChecksum);
  if (
    existingChecksum && input.checksum && existingChecksum !== input.checksum
  ) {
    throw conflict("Applied migration checksum changed", {
      resourceInstanceId: input.resourceInstanceId,
      migrationRef: input.migrationRef,
      expectedChecksum: existingChecksum,
      actualChecksum: input.checksum,
    });
  }
  for (const checkpoint of input.checkpoints ?? []) {
    if (!checkpoint.checksum) continue;
    const existingCheckpoint = entry.checkpoints.find((item) =>
      item.name === checkpoint.name && item.checksum !== undefined
    );
    if (
      existingCheckpoint?.checksum &&
      existingCheckpoint.checksum !== checkpoint.checksum
    ) {
      throw conflict("Applied migration checkpoint checksum changed", {
        resourceInstanceId: input.resourceInstanceId,
        migrationRef: input.migrationRef,
        checkpoint: checkpoint.name,
        expectedChecksum: existingCheckpoint.checksum,
        actualChecksum: checkpoint.checksum,
      });
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function compactJsonObject(
  value: Record<string, string | undefined>,
): JsonObject {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

export function upsertCondition<T extends { type: string }>(
  conditions: readonly T[] | undefined,
  next: T,
): readonly T[] {
  return [
    ...(conditions ?? []).filter((condition) => condition.type !== next.type),
    next,
  ];
}
