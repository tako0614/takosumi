export type ChangeSetChangeKind =
  | "group"
  | "publication"
  | "event"
  | "resource";

export type ChangeSetOperation = "create" | "update" | "delete";

export interface ChangeSetChange {
  readonly id: string;
  readonly kind: ChangeSetChangeKind;
  readonly operation: ChangeSetOperation;
  readonly groupId?: string;
  readonly dependsOn?: readonly string[];
  readonly description?: string;
}

export interface ChangeSetPlanInput {
  readonly id?: string;
  readonly changes: readonly ChangeSetChange[];
}

export interface ChangeSetPlanNode {
  readonly change: ChangeSetChange;
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
}

export interface ChangeSetDependencyEdge {
  readonly fromChangeId: string;
  readonly toChangeId: string;
  readonly reason:
    | "explicit"
    | "group-before-child"
    | "child-before-group-delete";
}

export interface ChangeSetPartialSuccessSemanticsDto {
  readonly kind: "change_set_partial_success_semantics";
  readonly distributedTransaction: false;
  readonly atomic: false;
  readonly rollback: "not-automatic";
  readonly failureMode: "failed-change-blocks-dependents-only";
  readonly resultContract:
    "each change is reported as succeeded, failed, skipped, or pending";
}

export interface ChangeSetPlan {
  readonly kind: "change_set_plan";
  readonly id?: string;
  readonly nodes: readonly ChangeSetPlanNode[];
  readonly edges: readonly ChangeSetDependencyEdge[];
  readonly topologicalOrder: readonly string[];
  readonly executionSemantics: ChangeSetPartialSuccessSemanticsDto;
}

export type ChangeSetAttemptStatus = "succeeded" | "failed";

export interface ChangeSetAttemptReport {
  readonly changeId: string;
  readonly status: ChangeSetAttemptStatus;
  readonly message?: string;
}

export type ChangeSetResultStatus =
  | "succeeded"
  | "partial_success"
  | "failed"
  | "pending";

export type ChangeSetChangeResultStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "pending";

export interface ChangeSetChangeResultDto {
  readonly changeId: string;
  readonly status: ChangeSetChangeResultStatus;
  readonly blockedBy: readonly string[];
  readonly message?: string;
}

export interface ChangeSetPartialSuccessResultDto {
  readonly kind: "change_set_apply_result";
  readonly planId?: string;
  readonly status: ChangeSetResultStatus;
  readonly distributedTransaction: false;
  readonly summary: {
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
    readonly pending: number;
  };
  readonly changes: readonly ChangeSetChangeResultDto[];
}
