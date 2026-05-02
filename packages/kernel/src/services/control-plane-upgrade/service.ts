import type { JsonObject, TakosumiActorContext } from "takosumi-contract";
import { invalidArgument, permissionDenied } from "../../shared/errors.ts";
import type {
  ControlPlaneMigration,
  ControlPlaneMigrationStepDto,
  ControlPlanePreflightCheckDto,
  ControlPlaneUpgradePlan,
  ControlPlaneUpgradePlanId,
} from "./types.ts";

export interface PlanControlPlaneUpgradeInput {
  readonly actor: TakosumiActorContext;
  readonly currentVersion?: string;
  readonly targetVersion: string;
  readonly dryRun?: boolean;
  readonly backupAvailable?: boolean;
  readonly backupRequired?: boolean;
  readonly migrationSteps?: readonly ControlPlaneMigrationStepDto[];
  readonly extraPreflightChecks?: readonly ControlPlanePreflightCheckDto[];
  readonly rollbackNotes?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ControlPlaneUpgradePlannerOptions {
  readonly idFactory?: () => ControlPlaneUpgradePlanId;
  readonly clock?: () => Date;
}

const DEFAULT_MIGRATION_STEPS: readonly ControlPlaneMigrationStepDto[] = Object
  .freeze([
    {
      id: "capture-control-plane-state",
      component: "paas",
      description:
        "Capture current tenant, space, routing, entitlement, and internal API state before upgrade.",
      required: true,
      destructive: false,
      rollbackHint:
        "Use the captured state with the pre-upgrade backup to validate rollback target integrity.",
    },
    {
      id: "apply-control-plane-migrations",
      component: "paas",
      description:
        "Apply control-plane schema and data migrations in documented order.",
      required: true,
      destructive: true,
      rollbackHint:
        "Stop rollout, restore the required backup, and re-run preflight checks before reopening traffic.",
    },
    {
      id: "verify-control-plane-health",
      component: "system",
      description:
        "Verify control-plane health, routing projections, and internal service reachability.",
      required: true,
      destructive: false,
      rollbackHint:
        "Keep old runtime/deploy service versions pinned until health verification passes.",
    },
  ]);

export class ControlPlaneUpgradePlanner {
  readonly #idFactory: () => ControlPlaneUpgradePlanId;
  readonly #clock: () => Date;

  constructor(options: ControlPlaneUpgradePlannerOptions = {}) {
    this.#idFactory = options.idFactory ?? crypto.randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  plan(input: PlanControlPlaneUpgradeInput): ControlPlaneUpgradePlan {
    assertOperator(input.actor);
    if (!input.targetVersion.trim()) {
      throw invalidArgument("targetVersion is required");
    }

    const backupRequired = input.backupRequired ?? true;
    const migrationSteps = input.migrationSteps ?? DEFAULT_MIGRATION_STEPS;
    const preflightChecks = buildPreflightChecks({
      targetVersion: input.targetVersion,
      backupRequired,
      backupAvailable: input.backupAvailable,
      migrationSteps,
      extraPreflightChecks: input.extraPreflightChecks,
    });
    const ok = preflightChecks.every((check) =>
      check.status !== "fail" || !check.required
    );

    return {
      id: this.#idFactory(),
      kind: "control-plane-upgrade-plan",
      ok,
      backupRequired,
      operation: {
        kind: "control-plane-upgrade",
        operatorOnly: true,
        requestedAt: this.#clock().toISOString(),
        requestedBy: {
          actorAccountId: input.actor.actorAccountId,
          roles: [...input.actor.roles],
          requestId: input.actor.requestId,
          principalKind: input.actor.principalKind,
          serviceId: input.actor.serviceId,
        },
        currentVersion: input.currentVersion,
        targetVersion: input.targetVersion,
        dryRun: input.dryRun ?? false,
        metadata: input.metadata,
      },
      preflightChecks,
      migrationSteps: [...migrationSteps],
      rollbackNotes: [
        {
          severity: "warning",
          note:
            "A verified control-plane backup is required before applying destructive migration steps.",
        },
        ...migrationSteps.flatMap((step) =>
          step.rollbackHint
            ? [{
              severity: "info" as const,
              stepId: step.id,
              note: step.rollbackHint,
            }]
            : []
        ),
        ...(input.rollbackNotes ?? []).map((note) => ({
          severity: "info" as const,
          note,
        })),
      ],
    };
  }

  createMigration(plan: ControlPlaneUpgradePlan): ControlPlaneMigration {
    return {
      kind: "control-plane-migration",
      planId: plan.id,
      status: "planned",
      backupRequired: plan.backupRequired,
      steps: [...plan.migrationSteps],
      rollbackNotes: [...plan.rollbackNotes],
    };
  }
}

function buildPreflightChecks(input: {
  readonly targetVersion: string;
  readonly backupRequired: boolean;
  readonly backupAvailable?: boolean;
  readonly migrationSteps: readonly ControlPlaneMigrationStepDto[];
  readonly extraPreflightChecks?: readonly ControlPlanePreflightCheckDto[];
}): ControlPlanePreflightCheckDto[] {
  return [
    {
      id: "target-version",
      label: "Target version specified",
      status: input.targetVersion.trim() ? "pass" : "fail",
      required: true,
    },
    {
      id: "backup-ready",
      label: "Control-plane backup ready",
      status: !input.backupRequired || input.backupAvailable ? "pass" : "fail",
      required: input.backupRequired,
      message: input.backupRequired && !input.backupAvailable
        ? "Set backupAvailable after verifying a restorable control-plane backup."
        : undefined,
    },
    {
      id: "migration-steps",
      label: "Migration steps prepared",
      status: input.migrationSteps.length > 0 ? "pass" : "fail",
      required: true,
    },
    ...(input.extraPreflightChecks ?? []),
  ];
}

function assertOperator(actor: TakosumiActorContext): void {
  if (!actor.roles.includes("operator") && !actor.roles.includes("owner")) {
    throw permissionDenied("Control-plane upgrades require an operator actor", {
      actorAccountId: actor.actorAccountId,
      roles: actor.roles,
    });
  }
}
