/**
 * Deferred-destroy finalizer for the two-phase uninstall.
 *
 * The cron drain claims the durable `capsule.deferred_destroy` work item and
 * hands it here. The CAPSULE ROW is the authority — the item only names the
 * `scheduledDestroyAt` it was minted for, and any mismatch (restore,
 * re-uninstall, already destroyed) makes the item a harmless no-op, so stale
 * items can never destroy anything.
 *
 * Order of operations, each idempotent:
 *   1. re-verify the Capsule is still uninstalled, due, and matches the item;
 *   2. attempt the pre-destroy data export ONCE and stamp the evidence
 *      (`exported` / `failed` / `skipped`) — an export failure never blocks
 *      the destroy, it is recorded and the destroy proceeds;
 *   3. create the destroy plan carrying the `systemDestroy` marker. The plan
 *      still parks `waiting_approval`; the engine's dedicated auto-continue
 *      re-verifies this same evidence and system-approves a delete-only plan.
 */

import type {
  Capsule,
  CapsulePreDestroyExport,
} from "takosumi-contract/capsules";
import type { ControlWorkItem } from "../deploy-control/store.ts";
import type { PlanRunSystemDestroy } from "@takosumi/internal/deploy-control-api";

export interface UninstallFinalizeOperations {
  readonly capsules: {
    getCapsule(id: string): Promise<Capsule>;
    recordCapsulePreDestroyExport(
      id: string,
      evidence: CapsulePreDestroyExport,
    ): Promise<Capsule>;
    getCapsuleRuntimeSafety(
      id: string,
    ): Promise<{ readonly phase: string } | undefined>;
  };
  /** Absent or `enabled: false` records an honest `skipped` evidence. */
  readonly backups?: {
    readonly enabled: boolean;
    createBackup(request: {
      readonly workspaceId: string;
      readonly capsuleId?: string;
      readonly environment?: string;
    }): Promise<{ readonly id: string }>;
  };
  readonly controller: {
    createCapsuleDestroyPlan(
      capsuleId: string,
      context: { readonly actor?: string },
      internal: { readonly systemDestroy?: PlanRunSystemDestroy },
    ): Promise<unknown>;
  };
}

export type UninstallFinalizeOutcome =
  | "destroy_planned"
  | "not_due"
  | "superseded"
  | "destroy_in_flight";

/** Truncated public-safe reason token from an arbitrary error. */
function exportFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

export async function finalizeScheduledCapsuleUninstall(
  operations: UninstallFinalizeOperations,
  item: ControlWorkItem,
  options: { readonly now?: () => Date } = {},
): Promise<UninstallFinalizeOutcome> {
  const capsuleId = item.capsuleId;
  if (!capsuleId) return "superseded";
  const payload = item.payload as
    | { readonly scheduledDestroyAt?: string }
    | undefined;
  const mintedFor = payload?.scheduledDestroyAt;
  const now = (options.now ?? (() => new Date()))();

  const capsule = await operations.capsules.getCapsule(capsuleId);
  // The Capsule row is the authority: restored, re-uninstalled with a new
  // schedule, or already destroyed all make this item a no-op.
  if (
    capsule.status !== "uninstalled" ||
    capsule.scheduledDestroyAt === undefined ||
    (mintedFor !== undefined && capsule.scheduledDestroyAt !== mintedFor)
  ) {
    return "superseded";
  }
  if (capsule.scheduledDestroyAt > now.toISOString()) return "not_due";
  const runtimeSafety = await operations.capsules.getCapsuleRuntimeSafety(
    capsuleId,
  );
  if (
    runtimeSafety?.phase === "terminating" ||
    runtimeSafety?.phase === "retired"
  ) {
    // A destroy is already in flight (or done); nothing more to schedule.
    return "destroy_in_flight";
  }

  // Pre-destroy export: attempted once, evidence-first, never blocking.
  let evidence = capsule.preDestroyExport;
  if (!evidence) {
    if (!operations.backups || operations.backups.enabled !== true) {
      evidence = {
        status: "skipped",
        reason: "backups_not_composed",
        at: now.toISOString(),
      };
    } else {
      try {
        const backup = await operations.backups.createBackup({
          workspaceId: capsule.workspaceId,
          capsuleId: capsule.id,
          environment: capsule.environment,
        });
        evidence = {
          status: "exported",
          backupId: backup.id,
          at: now.toISOString(),
        };
      } catch (error) {
        evidence = {
          status: "failed",
          reason: exportFailureReason(error),
          at: now.toISOString(),
        };
      }
    }
    await operations.capsules.recordCapsulePreDestroyExport(
      capsule.id,
      evidence,
    );
  }

  await operations.controller.createCapsuleDestroyPlan(
    capsule.id,
    { actor: "system:scheduled-uninstall" },
    {
      systemDestroy: {
        reason: "scheduled_uninstall",
        evidence: {
          scheduledDestroyAt: capsule.scheduledDestroyAt,
          ...(evidence.status === "exported" && evidence.backupId
            ? { preDestroyExportBackupId: evidence.backupId }
            : {}),
        },
      },
    },
  );
  return "destroy_planned";
}
