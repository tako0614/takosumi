import type { JsonObject, TakosumiActorContext } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type ControlPlaneUpgradePlanId = string;
export type ControlPlaneMigrationStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "rolled-back";
export type ControlPlanePreflightStatus = "pass" | "warning" | "fail";
export type ControlPlaneRollbackSeverity = "info" | "warning";

export interface ControlPlaneUpgradeOperationDto {
  readonly kind: "control-plane-upgrade";
  readonly operatorOnly: true;
  readonly requestedAt: IsoTimestamp;
  readonly requestedBy: Pick<
    TakosumiActorContext,
    "actorAccountId" | "roles" | "requestId" | "principalKind" | "serviceId"
  >;
  readonly currentVersion?: string;
  readonly targetVersion: string;
  readonly dryRun: boolean;
  readonly metadata?: JsonObject;
}

export interface ControlPlanePreflightCheckDto {
  readonly id: string;
  readonly label: string;
  readonly status: ControlPlanePreflightStatus;
  readonly required: boolean;
  readonly message?: string;
  readonly details?: JsonObject;
}

export interface ControlPlaneMigrationStepDto {
  readonly id: string;
  readonly component:
    | "paas"
    | "app"
    | "git"
    | "deploy"
    | "runtime"
    | "agent"
    | "docs"
    | "system";
  readonly description: string;
  readonly required: boolean;
  readonly destructive: boolean;
  readonly rollbackHint?: string;
}

export interface ControlPlaneRollbackNoteDto {
  readonly severity: ControlPlaneRollbackSeverity;
  readonly note: string;
  readonly stepId?: string;
}

export interface ControlPlaneUpgradePlan {
  readonly id: ControlPlaneUpgradePlanId;
  readonly kind: "control-plane-upgrade-plan";
  readonly ok: boolean;
  readonly backupRequired: boolean;
  readonly operation: ControlPlaneUpgradeOperationDto;
  readonly preflightChecks: readonly ControlPlanePreflightCheckDto[];
  readonly migrationSteps: readonly ControlPlaneMigrationStepDto[];
  readonly rollbackNotes: readonly ControlPlaneRollbackNoteDto[];
}

export interface ControlPlaneMigration {
  readonly kind: "control-plane-migration";
  readonly planId: ControlPlaneUpgradePlanId;
  readonly status: ControlPlaneMigrationStatus;
  readonly backupRequired: boolean;
  readonly steps: readonly ControlPlaneMigrationStepDto[];
  readonly rollbackNotes: readonly ControlPlaneRollbackNoteDto[];
}
