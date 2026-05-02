import type {
  ApprovalRecord,
  ApprovalRecordStatus,
  ApprovalSubjectRef,
} from "./types.ts";

export interface ApprovalStore {
  put(record: ApprovalRecord): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  listBySubject(
    subject: ApprovalSubjectRef,
  ): Promise<readonly ApprovalRecord[]>;
  invalidateSubjectDigest(input: {
    readonly subject: ApprovalSubjectRef;
    readonly subjectDigest: string;
    readonly invalidatedAt: string;
    readonly reason: string;
  }): Promise<readonly ApprovalRecord[]>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #records = new Map<string, ApprovalRecord>();

  put(record: ApprovalRecord): Promise<ApprovalRecord> {
    this.#records.set(record.id, freezeRecord(record));
    return Promise.resolve(this.#records.get(record.id)!);
  }

  get(id: string): Promise<ApprovalRecord | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  listBySubject(
    subject: ApprovalSubjectRef,
  ): Promise<readonly ApprovalRecord[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => sameSubject(record, subject))
        .sort((left, right) => left.approvedAt.localeCompare(right.approvedAt)),
    );
  }

  async invalidateSubjectDigest(input: {
    readonly subject: ApprovalSubjectRef;
    readonly subjectDigest: string;
    readonly invalidatedAt: string;
    readonly reason: string;
  }): Promise<readonly ApprovalRecord[]> {
    const invalidated: ApprovalRecord[] = [];
    for (const record of await this.listBySubject(input.subject)) {
      if (record.status !== "valid") continue;
      if (record.subjectDigest === input.subjectDigest) continue;
      const next = freezeRecord({
        ...record,
        status: "invalidated" as ApprovalRecordStatus,
        invalidatedAt: input.invalidatedAt,
        invalidationReason: input.reason,
      });
      this.#records.set(record.id, next);
      invalidated.push(next);
    }
    return invalidated;
  }
}

function sameSubject(
  left: ApprovalSubjectRef,
  right: ApprovalSubjectRef,
): boolean {
  return left.spaceId === right.spaceId &&
    left.groupId === right.groupId &&
    left.operation === right.operation &&
    left.subjectId === right.subjectId;
}

function freezeRecord(record: ApprovalRecord): ApprovalRecord {
  return Object.freeze({
    ...record,
    approvedByRoles: Object.freeze([...record.approvedByRoles]),
    requiredRoles: record.requiredRoles
      ? Object.freeze([...record.requiredRoles])
      : undefined,
  });
}
