import type { RuntimeBindingRecord } from "./ledger.ts";

export interface SharedCellRuntimeAllocationInput {
  capsuleId: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  createdBySubject: string;
  now: number;
}

export type SharedCellRuntimeAllocator = (
  input: SharedCellRuntimeAllocationInput,
) =>
  | RuntimeBindingRecord
  | undefined
  | Promise<RuntimeBindingRecord | undefined>;

export interface SharedCellWarmPoolSlot {
  cellId: string;
  capacity: number;
}

type MutableSharedCellWarmPoolSlot = {
  cellId: string;
  capacity: number;
  assignedCapsules: Set<string>;
};

export class InMemorySharedCellWarmPool {
  readonly #slots: MutableSharedCellWarmPoolSlot[];

  constructor(slots: readonly SharedCellWarmPoolSlot[]) {
    this.#slots = slots.map((slot) => {
      if (!isValidCellId(slot.cellId)) {
        throw new TypeError("shared-cell slot cellId must be a stable id");
      }
      if (!Number.isInteger(slot.capacity) || slot.capacity < 1) {
        throw new TypeError(
          "shared-cell slot capacity must be a positive integer",
        );
      }
      return {
        cellId: slot.cellId,
        capacity: slot.capacity,
        assignedCapsules: new Set<string>(),
      };
    });
  }

  allocate(
    input: SharedCellRuntimeAllocationInput,
  ): RuntimeBindingRecord | undefined {
    const existing = this.#slots.find((slot) =>
      slot.assignedCapsules.has(input.capsuleId),
    );
    const slot =
      existing ??
      this.#slots.find(
        (candidate) =>
          candidate.assignedCapsules.size < candidate.capacity,
      );
    if (!slot) return undefined;
    slot.assignedCapsules.add(input.capsuleId);
    return sharedCellRuntimeBinding({
      capsuleId: input.capsuleId,
      cellId: slot.cellId,
      now: input.now,
    });
  }

  availableSlots(): readonly SharedCellWarmPoolSlot[] {
    return this.#slots.map((slot) => ({
      cellId: slot.cellId,
      capacity: slot.capacity - slot.assignedCapsules.size,
    }));
  }
}

export function sharedCellRuntimeBinding(input: {
  capsuleId: string;
  cellId: string;
  now: number;
}): RuntimeBindingRecord {
  if (!isValidRuntimeId(input.capsuleId)) {
    throw new TypeError("capsuleId must be usable in runtime binding ids");
  }
  if (!isValidCellId(input.cellId)) {
    throw new TypeError("cellId must be a stable id");
  }
  return {
    runtimeBindingId: `rtb_${input.capsuleId}_shared_cell`,
    capsuleId: input.capsuleId,
    mode: "shared-cell",
    targetType: "shared-cell",
    targetId: `shared-cell://${input.cellId}/namespaces/${input.capsuleId}`,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function isValidRuntimeId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidCellId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}
