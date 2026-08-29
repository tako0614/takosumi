import type { CapsuleInterfaceBlueprint } from "takosumi-contract";
import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";
import { validateCapsuleInterfaceBlueprints } from "../interfaces/service.ts";

/** Hard ceiling for the complete, canonical blueprint snapshot persisted per Apply. */
export const CAPSULE_INTERFACE_BLUEPRINTS_MAX_BYTES = 1_048_576;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** Private Plan sidecar authority; never projected into the public Run model. */
export interface PlanPinnedCapsuleInterfaceMaterialization {
  readonly installConfigId: string;
  readonly blueprints: readonly CapsuleInterfaceBlueprint[];
  readonly blueprintsDigest: string;
}

export type CapsuleInterfaceMaterializationIntentStatus =
  | "pending"
  | "completed"
  | "dead_letter";

export type CapsuleInterfaceMaterializationIntentDisposition =
  | "materialized"
  | "retired_before_materialization"
  | "superseded_before_materialization";

/**
 * Durable, unresolved Interface materialization authority.
 *
 * This record deliberately carries only the reviewed blueprint declaration and
 * ledger identities. It never carries resolved Output values, raw state,
 * runner credentials, or generated tokens.
 */
export interface CapsuleInterfaceMaterializationIntent {
  readonly id: string;
  /** Initial Apply obligation identity. Absent only for a Restore replacement. */
  readonly applyRunId?: string;
  /** Restore that rebased the exact source snapshot into this obligation. */
  readonly restoreRunId?: string;
  /** Immutable predecessor whose reviewed blueprint snapshot was copied. */
  readonly sourceIntentId?: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
  readonly blueprintsDigest: string;
  readonly blueprints: readonly CapsuleInterfaceBlueprint[];
  /** Durable flattened Interface + Binding work-unit boundary. */
  readonly totalItems: number;
  /** Zero-based next uncompleted work unit. */
  readonly nextItemIndex: number;
  readonly status: CapsuleInterfaceMaterializationIntentStatus;
  readonly attempts: number;
  readonly nextRetryAt: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  /** Redacted/structured failure evidence only; never a raw exception. */
  readonly error?: {
    readonly code: string;
    readonly detailDigest: string;
    readonly recordedAt: string;
  };
  /** Value-free completion receipt; Output contents are intentionally absent. */
  readonly receipt?: {
    readonly disposition: CapsuleInterfaceMaterializationIntentDisposition;
    readonly blueprintsDigest: string;
    readonly completedAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly deadLetteredAt?: string;
}

/**
 * Exact durable authority carried into one canonical Interface/Binding write.
 *
 * A preflight check alone is insufficient: the intent lease or Capsule lineage
 * can move after the check and before the adapter mutation. Durable adapters
 * therefore consume this snapshot in the same conditional statement as the
 * authority write; the in-memory adapter validates and mutates synchronously.
 */
export interface InterfaceMaterializationWriteAuthority {
  readonly intentId: string;
  readonly leaseToken: string;
  readonly expectedNextItemIndex: number;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
}

export function capsuleInterfaceMaterializationIntentId(
  applyRunId: string,
): string {
  const normalized = requiredText(applyRunId, "applyRunId");
  return `cimi_${normalized}`;
}

export function restoredCapsuleInterfaceMaterializationIntentId(
  restoreRunId: string,
): string {
  return `cimi_restore_${requiredText(restoreRunId, "restoreRunId")}`;
}

/** Validate, JSON-normalize, cap, and digest the exact Plan-time declaration. */
export async function pinCapsuleInterfaceBlueprints(input: {
  readonly installConfigId: string;
  readonly blueprints: readonly CapsuleInterfaceBlueprint[] | undefined;
}): Promise<PlanPinnedCapsuleInterfaceMaterialization | undefined> {
  const installConfigId = requiredText(input.installConfigId, "installConfigId");
  if (!input.blueprints?.length) return undefined;
  validateCapsuleInterfaceBlueprints(input.blueprints);
  const blueprints = normalizeBlueprints(input.blueprints);
  const canonicalJson = stableStringify(blueprints);
  assertBlueprintPayloadSize(canonicalJson);
  return {
    installConfigId,
    blueprints,
    blueprintsDigest: await stableJsonDigest(blueprints),
  };
}

export function createCapsuleInterfaceMaterializationIntent(input: {
  readonly applyRunId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
  readonly pinned: PlanPinnedCapsuleInterfaceMaterialization;
  readonly createdAt: string;
}): CapsuleInterfaceMaterializationIntent {
  if (!Number.isSafeInteger(input.stateGeneration) || input.stateGeneration < 1) {
    throw new TypeError("stateGeneration must be a positive safe integer");
  }
  const createdAt = requiredText(input.createdAt, "createdAt");
  return {
    id: capsuleInterfaceMaterializationIntentId(input.applyRunId),
    applyRunId: requiredText(input.applyRunId, "applyRunId"),
    workspaceId: requiredText(input.workspaceId, "workspaceId"),
    capsuleId: requiredText(input.capsuleId, "capsuleId"),
    installConfigId: requiredText(
      input.pinned.installConfigId,
      "installConfigId",
    ),
    stateVersionId: requiredText(input.stateVersionId, "stateVersionId"),
    outputId: requiredText(input.outputId, "outputId"),
    stateGeneration: input.stateGeneration,
    blueprintsDigest: requiredDigest(
      input.pinned.blueprintsDigest,
      "blueprintsDigest",
    ),
    blueprints: normalizeBlueprints(input.pinned.blueprints),
    totalItems: capsuleInterfaceMaterializationWorkItemCount(
      input.pinned.blueprints,
    ),
    nextItemIndex: 0,
    status: "pending",
    attempts: 0,
    nextRetryAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

/** Copy one exact durable Apply/Restore snapshot onto a restored generation. */
export function createRestoredCapsuleInterfaceMaterializationIntent(input: {
  readonly restoreRunId: string;
  readonly sourceIntent: CapsuleInterfaceMaterializationIntent;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
  readonly createdAt: string;
}): CapsuleInterfaceMaterializationIntent {
  if (!Number.isSafeInteger(input.stateGeneration) || input.stateGeneration < 1) {
    throw new TypeError("stateGeneration must be a positive safe integer");
  }
  const createdAt = requiredText(input.createdAt, "createdAt");
  const restoreRunId = requiredText(input.restoreRunId, "restoreRunId");
  const blueprints = normalizeBlueprints(input.sourceIntent.blueprints);
  return {
    id: restoredCapsuleInterfaceMaterializationIntentId(restoreRunId),
    restoreRunId,
    sourceIntentId: requiredText(input.sourceIntent.id, "sourceIntentId"),
    workspaceId: requiredText(input.sourceIntent.workspaceId, "workspaceId"),
    capsuleId: requiredText(input.sourceIntent.capsuleId, "capsuleId"),
    installConfigId: requiredText(
      input.sourceIntent.installConfigId,
      "installConfigId",
    ),
    stateVersionId: requiredText(input.stateVersionId, "stateVersionId"),
    outputId: requiredText(input.outputId, "outputId"),
    stateGeneration: input.stateGeneration,
    blueprintsDigest: requiredDigest(
      input.sourceIntent.blueprintsDigest,
      "blueprintsDigest",
    ),
    blueprints,
    totalItems: capsuleInterfaceMaterializationWorkItemCount(blueprints),
    nextItemIndex: 0,
    status: "pending",
    attempts: 0,
    nextRetryAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

export function capsuleInterfaceMaterializationWorkItemCount(
  blueprints: readonly CapsuleInterfaceBlueprint[],
): number {
  return blueprints.reduce(
    (total, blueprint) => total + 1 + (blueprint.bindings?.length ?? 0),
    0,
  );
}

export type CapsuleInterfaceMaterializationWorkItem =
  | {
      readonly kind: "interface";
      readonly itemIndex: number;
      readonly blueprintIndex: number;
      readonly blueprint: CapsuleInterfaceBlueprint;
    }
  | {
      readonly kind: "binding";
      readonly itemIndex: number;
      readonly blueprintIndex: number;
      readonly bindingIndex: number;
      readonly blueprint: CapsuleInterfaceBlueprint;
      readonly binding: NonNullable<CapsuleInterfaceBlueprint["bindings"]>[number];
    };

/** Deterministic flattened cursor: Interface first, then its ordered Bindings. */
export function capsuleInterfaceMaterializationWorkItemAt(
  blueprints: readonly CapsuleInterfaceBlueprint[],
  itemIndex: number,
): CapsuleInterfaceMaterializationWorkItem {
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) {
    throw new TypeError("itemIndex must be a non-negative safe integer");
  }
  let cursor = 0;
  for (let blueprintIndex = 0; blueprintIndex < blueprints.length; blueprintIndex += 1) {
    const blueprint = blueprints[blueprintIndex]!;
    if (cursor === itemIndex) {
      return { kind: "interface", itemIndex, blueprintIndex, blueprint };
    }
    cursor += 1;
    for (
      let bindingIndex = 0;
      bindingIndex < (blueprint.bindings?.length ?? 0);
      bindingIndex += 1
    ) {
      if (cursor === itemIndex) {
        return {
          kind: "binding",
          itemIndex,
          blueprintIndex,
          bindingIndex,
          blueprint,
          binding: blueprint.bindings![bindingIndex]!,
        };
      }
      cursor += 1;
    }
  }
  throw new RangeError("itemIndex is outside the materialization declaration");
}

/** Canonical JSON persisted in the protected-lineage table's blueprints_json. */
export function capsuleInterfaceBlueprintsJson(
  blueprints: readonly CapsuleInterfaceBlueprint[],
): string {
  const normalized = normalizeBlueprints(blueprints);
  const json = stableStringify(normalized);
  assertBlueprintPayloadSize(json);
  return json;
}

/** Fail closed before any store write if an intent is malformed or tampered. */
export async function validateCapsuleInterfaceMaterializationIntent(
  intent: CapsuleInterfaceMaterializationIntent,
): Promise<void> {
  assertOnlyKeys(
    intent,
    [
      "id",
      "applyRunId",
      "restoreRunId",
      "sourceIntentId",
      "workspaceId",
      "capsuleId",
      "installConfigId",
      "stateVersionId",
      "outputId",
      "stateGeneration",
      "blueprintsDigest",
      "blueprints",
      "totalItems",
      "nextItemIndex",
      "status",
      "attempts",
      "nextRetryAt",
      "leaseToken",
      "leaseExpiresAt",
      "error",
      "receipt",
      "createdAt",
      "updatedAt",
      "completedAt",
      "deadLetteredAt",
    ],
    "Interface materialization intent",
  );
  const isApply = intent.applyRunId !== undefined;
  const isRestore = intent.restoreRunId !== undefined;
  if (isApply === isRestore) {
    throw new TypeError(
      "Interface materialization intent requires exactly one creation run",
    );
  }
  const expectedId = isApply
    ? capsuleInterfaceMaterializationIntentId(intent.applyRunId!)
    : restoredCapsuleInterfaceMaterializationIntentId(intent.restoreRunId!);
  if (intent.id !== expectedId) {
    throw new TypeError(
      "Interface materialization intent id does not match its creation run",
    );
  }
  if (isRestore) {
    requiredText(intent.sourceIntentId!, "sourceIntentId");
  } else if (intent.sourceIntentId !== undefined) {
    throw new TypeError("Apply Interface materialization intent has a sourceIntentId");
  }
  requiredText(intent.workspaceId, "workspaceId");
  requiredText(intent.capsuleId, "capsuleId");
  requiredText(intent.installConfigId, "installConfigId");
  requiredText(intent.stateVersionId, "stateVersionId");
  requiredText(intent.outputId, "outputId");
  if (!Number.isSafeInteger(intent.stateGeneration) || intent.stateGeneration < 1) {
    throw new TypeError("stateGeneration must be a positive safe integer");
  }
  if (!Number.isSafeInteger(intent.attempts) || intent.attempts < 0) {
    throw new TypeError("attempts must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(intent.totalItems) ||
    intent.totalItems < 1 ||
    !Number.isSafeInteger(intent.nextItemIndex) ||
    intent.nextItemIndex < 0 ||
    intent.nextItemIndex > intent.totalItems
  ) {
    throw new TypeError("Interface materialization intent work cursor is invalid");
  }
  if (
    intent.status !== "pending" &&
    intent.status !== "completed" &&
    intent.status !== "dead_letter"
  ) {
    throw new TypeError("invalid Interface materialization intent status");
  }
  requiredText(intent.nextRetryAt, "nextRetryAt");
  requiredText(intent.createdAt, "createdAt");
  requiredText(intent.updatedAt, "updatedAt");
  if (intent.completedAt !== undefined) {
    requiredText(intent.completedAt, "completedAt");
  }
  if (intent.deadLetteredAt !== undefined) {
    requiredText(intent.deadLetteredAt, "deadLetteredAt");
  }
  if (intent.leaseToken !== undefined) {
    requiredText(intent.leaseToken, "leaseToken");
  }
  if (intent.leaseExpiresAt !== undefined) {
    requiredText(intent.leaseExpiresAt, "leaseExpiresAt");
  }
  if (
    (intent.leaseToken === undefined) !==
      (intent.leaseExpiresAt === undefined)
  ) {
    throw new TypeError(
      "leaseToken and leaseExpiresAt must be present or absent together",
    );
  }
  if (intent.error !== undefined) {
    assertOnlyKeys(
      intent.error,
      ["code", "detailDigest", "recordedAt"],
      "error",
    );
    requiredText(intent.error.code, "error.code");
    requiredDigest(intent.error.detailDigest, "error.detailDigest");
    requiredText(intent.error.recordedAt, "error.recordedAt");
  }
  if (intent.receipt !== undefined) {
    assertOnlyKeys(
      intent.receipt,
      ["disposition", "blueprintsDigest", "completedAt"],
      "receipt",
    );
    if (
      intent.receipt.disposition !== "materialized" &&
      intent.receipt.disposition !== "retired_before_materialization" &&
      intent.receipt.disposition !== "superseded_before_materialization"
    ) {
      throw new TypeError("receipt.disposition is invalid");
    }
    if (
      requiredDigest(
        intent.receipt.blueprintsDigest,
        "receipt.blueprintsDigest",
      ) !== intent.blueprintsDigest
    ) {
      throw new TypeError("receipt.blueprintsDigest does not match intent");
    }
    requiredText(intent.receipt.completedAt, "receipt.completedAt");
  }
  if (intent.status === "pending") {
    if (
      intent.nextItemIndex >= intent.totalItems ||
      intent.receipt !== undefined ||
      intent.completedAt !== undefined ||
      intent.deadLetteredAt !== undefined
    ) {
      throw new TypeError("pending Interface materialization intent is terminal");
    }
  } else if (intent.status === "completed") {
    if (
      !intent.receipt ||
      !intent.completedAt ||
      intent.receipt.completedAt !== intent.completedAt ||
      intent.error !== undefined ||
      intent.deadLetteredAt !== undefined ||
      intent.leaseToken !== undefined
    ) {
      throw new TypeError("completed Interface materialization intent is invalid");
    }
    if (
      intent.receipt.disposition === "materialized" &&
      intent.nextItemIndex !== intent.totalItems
    ) {
      throw new TypeError(
        "materialized Interface materialization intent has incomplete work",
      );
    }
  } else if (
    !intent.error ||
    !intent.deadLetteredAt ||
    intent.receipt !== undefined ||
    intent.completedAt !== undefined ||
    intent.leaseToken !== undefined
  ) {
    throw new TypeError("dead-letter Interface materialization intent is invalid");
  }
  const digest = requiredDigest(intent.blueprintsDigest, "blueprintsDigest");
  validateCapsuleInterfaceBlueprints(intent.blueprints);
  if (intent.blueprints.length === 0) {
    throw new TypeError("Interface materialization intent requires blueprints");
  }
  const normalized = normalizeBlueprints(intent.blueprints);
  const json = stableStringify(normalized);
  assertBlueprintPayloadSize(json);
  if ((await stableJsonDigest(normalized)) !== digest) {
    throw new TypeError("Interface materialization intent blueprint digest mismatch");
  }
  if (
    capsuleInterfaceMaterializationWorkItemCount(normalized) !==
    intent.totalItems
  ) {
    throw new TypeError("Interface materialization intent totalItems mismatch");
  }
}

/** Exact immutable-content identity used by every substrate's replay adoption. */
export function capsuleInterfaceMaterializationIntentContentKey(
  intent: CapsuleInterfaceMaterializationIntent,
): string {
  return stableStringify({
    id: intent.id,
    applyRunId: intent.applyRunId,
    restoreRunId: intent.restoreRunId,
    sourceIntentId: intent.sourceIntentId,
    workspaceId: intent.workspaceId,
    capsuleId: intent.capsuleId,
    installConfigId: intent.installConfigId,
    stateVersionId: intent.stateVersionId,
    outputId: intent.outputId,
    stateGeneration: intent.stateGeneration,
    blueprintsDigest: intent.blueprintsDigest,
    blueprints: normalizeBlueprints(intent.blueprints),
    totalItems: intent.totalItems,
  });
}

function normalizeBlueprints(
  blueprints: readonly CapsuleInterfaceBlueprint[],
): readonly CapsuleInterfaceBlueprint[] {
  const encoded = JSON.stringify(blueprints);
  if (encoded === undefined) {
    throw new TypeError("interfaceBlueprints must be JSON serializable");
  }
  return JSON.parse(encoded) as readonly CapsuleInterfaceBlueprint[];
}

function assertBlueprintPayloadSize(canonicalJson: string): void {
  const size = new TextEncoder().encode(canonicalJson).byteLength;
  if (size > CAPSULE_INTERFACE_BLUEPRINTS_MAX_BYTES) {
    throw new TypeError(
      `interfaceBlueprints exceeds ${CAPSULE_INTERFACE_BLUEPRINTS_MAX_BYTES} bytes`,
    );
  }
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredDigest(value: string, field: string): string {
  if (!SHA256_DIGEST.test(value)) {
    throw new TypeError(`${field} must be sha256:<lowercase hex>`);
  }
  return value;
}

function assertOnlyKeys(
  value: unknown,
  allowed: readonly string[],
  field: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`${field} contains an unsupported field`);
  }
}
