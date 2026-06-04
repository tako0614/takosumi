// Pure shared helpers used by every in-memory store class:
//  - `immutable`: freeze a deep copy so a returned value cannot be mutated by
//    callers (re-exported from the shared `freeze` primitive)
//  - composite-key formatters (`membershipKey`, `packageKey`)
//  - small predicates used by audit stores

import type { AccountId, SpaceId } from "../../../domains/space/types.ts";
import type {
  AuditEvent,
  AuditEventQuery,
} from "../../../domains/audit/types.ts";
import type { PackageKind } from "../../../domains/registry/types.ts";

export { immutable } from "../../../shared/freeze.ts";

export function membershipKey(
  spaceId: SpaceId,
  accountId: AccountId,
): string {
  return `${spaceId}:${accountId}`;
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
