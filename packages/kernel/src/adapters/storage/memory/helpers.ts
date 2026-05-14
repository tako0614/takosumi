// Pure shared helpers used by every in-memory store class:
//  - `immutable` / `deepFreeze`: freeze a deep copy so a returned value
//    cannot be mutated by callers
//  - composite-key formatters (`membershipKey`, `groupHeadKey`, `packageKey`)
//  - small predicates used by deploy and audit stores

import type { AccountId, SpaceId } from "../../../domains/core/types.ts";
import type {
  AuditEvent,
  AuditEventQuery,
} from "../../../domains/audit/types.ts";
import type { Deployment } from "takosumi-contract";
import type {
  AdvanceGroupHeadInput,
  DeploymentFilter,
} from "../../../domains/deploy/store.ts";
import type { PackageKind } from "../../../domains/registry/types.ts";

export function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function membershipKey(
  spaceId: SpaceId,
  accountId: AccountId,
): string {
  return `${spaceId}:${accountId}`;
}

export function groupHeadKey(spaceId: string, groupId: string): string {
  return `${spaceId}\u0000${groupId}`;
}

export function assertDeploymentHeadScope(
  input: AdvanceGroupHeadInput,
  deployment: Deployment,
): void {
  if (deployment.space_id !== input.spaceId) {
    throw new Error(
      `deployment ${deployment.id} belongs to space ${deployment.space_id}, not ${input.spaceId}`,
    );
  }
  if (deployment.group_id !== input.groupId) {
    throw new Error(
      `deployment ${deployment.id} belongs to group ${deployment.group_id}, not ${input.groupId}`,
    );
  }
}

export function normalizeDeploymentStatusFilter(
  status: DeploymentFilter["status"],
): Set<Deployment["status"]> | undefined {
  if (status === undefined) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

export function packageKey(
  kind: PackageKind,
  ref: string,
  digest: string,
): string {
  return `${kind}:${ref}:${digest}`;
}

export function matchesAuditQuery(
  event: AuditEvent,
  query: AuditEventQuery,
): boolean {
  if (query.spaceId && event.spaceId !== query.spaceId) return false;
  if (query.groupId && event.groupId !== query.groupId) return false;
  if (query.targetType && event.targetType !== query.targetType) return false;
  if (query.targetId && event.targetId !== query.targetId) return false;
  if (query.type && event.type !== query.type) return false;
  if (query.since && event.occurredAt < query.since) return false;
  if (query.until && event.occurredAt > query.until) return false;
  return true;
}

export function minIso(left: string, right: string): string {
  return left <= right ? left : right;
}

export function maxIso(left: string, right: string): string {
  return left >= right ? left : right;
}
