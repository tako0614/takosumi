import type {
  AccountId,
  CoreRole,
  GroupId,
  SpaceId,
} from "../../domains/core/mod.ts";

export type ApprovalOperation = "deploy.plan" | "deploy.apply";
export type ApprovalKind = "manual" | "role";
export type ApprovalRecordStatus = "valid" | "invalidated";

export interface ApprovalActor {
  readonly accountId: AccountId;
  readonly roles: readonly CoreRole[];
}

export interface ApprovalSubjectRef {
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly operation: ApprovalOperation;
  readonly subjectId: string;
}

export interface ApprovalSubject<T = unknown> extends ApprovalSubjectRef {
  readonly subject: T;
}

export interface ApprovalRecord extends ApprovalSubjectRef {
  readonly id: string;
  readonly subjectDigest: string;
  readonly kind: ApprovalKind;
  readonly status: ApprovalRecordStatus;
  readonly approvedBy: AccountId;
  readonly approvedByRoles: readonly CoreRole[];
  readonly approvedAt: string;
  readonly requiredRoles?: readonly CoreRole[];
  readonly invalidatedAt?: string;
  readonly invalidationReason?: string;
}

export interface ApprovalRequirement {
  readonly manual?: boolean;
  readonly roles?: readonly CoreRole[];
}

export interface ApprovalGateInput<T = unknown> extends ApprovalSubject<T> {
  readonly actor: ApprovalActor;
  readonly requirement?: ApprovalRequirement;
  readonly checkedAt?: string;
}

export interface ApprovalGateDecision {
  readonly allowed: boolean;
  readonly operation: ApprovalOperation;
  readonly subjectDigest: string;
  readonly reason: string;
  readonly approval?: ApprovalRecord;
  readonly missingRoles?: readonly CoreRole[];
}
