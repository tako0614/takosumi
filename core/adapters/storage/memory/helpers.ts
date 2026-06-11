// Pure shared helpers used by every in-memory store class:
//  - `immutable`: freeze a deep copy so a returned value cannot be mutated by
//    callers (re-exported from the shared `freeze` primitive)
//  - generic Map CRUD primitives (`getFrom`, `filterValues`, `createIfAbsent`,
//    `putValue`) that every store delegates its boilerplate get / listBy* /
//    create / put bodies to; domain-specific composite-key finders stay in the
//    individual store classes
//  - composite-key formatters (`membershipKey`, `packageKey`)
//  - small predicates used by audit stores

import type { AccountId, SpaceId } from "../../../domains/membership/types.ts";
import type {
  AuditEvent,
  AuditEventQuery,
} from "../../../domains/audit/types.ts";
import type { PackageKind } from "../../../domains/registry/types.ts";
import { immutable } from "../../../shared/freeze.ts";

export { immutable };

/**
 * Resolve a single value by key. Backs the uniform
 * `get(id) => Promise.resolve(this.map.get(id))` store bodies.
 */
export function getFrom<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
): Promise<V | undefined> {
  return Promise.resolve(map.get(key));
}

/**
 * Snapshot the values matching `pred`. Backs the uniform
 * `[...this.map.values()].filter(...)` store bodies for `listBy*` finders.
 */
export function filterValues<V>(
  map: ReadonlyMap<unknown, V>,
  pred: (value: V) => boolean,
): Promise<readonly V[]> {
  return Promise.resolve([...map.values()].filter(pred));
}

/**
 * Insert `value` under `key` only if absent, returning the existing entry
 * unchanged on conflict. The stored value is frozen via {@link immutable}.
 * Backs the uniform create-with-existing-check store bodies.
 */
export function createIfAbsent<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
): Promise<V> {
  const existing = map.get(key);
  if (existing) return Promise.resolve(existing);
  const frozen = immutable(value);
  map.set(key, frozen);
  return Promise.resolve(frozen);
}

/**
 * Freeze and store `value` under `key`, replacing any existing entry, and
 * return the frozen value. Backs the uniform put / update / record store
 * bodies that overwrite by id (or composite key).
 */
export function putValue<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
): Promise<V> {
  const frozen = immutable(value);
  map.set(key, frozen);
  return Promise.resolve(frozen);
}

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
