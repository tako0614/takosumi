import type { D1Database } from "../../worker/src/bindings.ts";
import { assertControlD1MaintenanceInactive } from "../../worker/src/d1_schema_maintenance.ts";

/**
 * The narrow read port every bounded Control D1 authority reader consumes.
 *
 * It exposes exactly `prepare(...).bind(...).all()`: no `first`, no `run`, no
 * `batch`, no `exec`. A reader holding one of these cannot mutate and cannot
 * run schema work, which is what makes the bounded readers safe to compose
 * outside the deploy-control store.
 */
export interface ReadOnlyD1Database {
  prepare(query: string): ReadOnlyD1PreparedStatement;
}

export interface ReadOnlyD1PreparedStatement {
  bind(...values: readonly unknown[]): ReadOnlyD1PreparedStatement;
  all<T = unknown>(): Promise<{
    readonly success?: boolean;
    readonly results?: readonly T[];
  }>;
}

declare const fencedControlDatabaseBrand: unique symbol;

/**
 * A Control D1 read port that has already been placed behind the operator
 * maintenance fence.
 *
 * The brand exists so the fence is a property of the *binding* rather than a
 * convention every reader has to remember. A bounded reader declares it needs
 * a `FencedControlDatabase`, so handing it `env.TAKOSUMI_CONTROL_DB` directly
 * is a compile error rather than a silently unfenced authority path.
 */
export interface FencedControlDatabase extends ReadOnlyD1Database {
  readonly [fencedControlDatabaseBrand]: true;
}

const fenced = new WeakMap<D1Database, FencedControlDatabase>();

/**
 * Wrap the Control D1 binding once, at composition, behind the durable
 * maintenance fence.
 *
 * WHY this exists. `assertControlD1MaintenanceInactive` used to be reachable
 * only through `CloudflareD1OpenTofuControlStore`, so every store-mediated
 * request refused with `maintenance_fence_active` while an operator held the
 * fence — but the bounded PAT and Workspace-bootstrap readers issue their own
 * `SELECT`s against the same database and never consulted it. During a control
 * schema migration the store said "unavailable" and PAT authorization kept
 * answering `resources:read` off a half-migrated `workspace_members` table.
 *
 * The readers' bypass of the store's *lazy bootstrap* is deliberate and is
 * preserved here: this façade never creates a store, never runs DDL and never
 * writes. It adds exactly one durable fence read in front of each bounded read.
 * A held fence therefore refuses with `ControlD1MaintenanceError`, the same
 * retryable signal every other Control D1 caller already gets, instead of
 * granting authority from a table that is mid-migration.
 *
 * The same binding always yields the same façade, so "wrapped once at
 * composition" is a fact about the object graph rather than a convention.
 */
export function fenceControlDatabase(db: D1Database): FencedControlDatabase {
  const existing = fenced.get(db);
  if (existing) return existing;
  const facade = fencedDatabase(db, db);
  fenced.set(db, facade);
  return facade;
}

/**
 * Test seam: fence an already-narrow read port against a separate fence
 * database. Production always fences a binding against itself; the split exists
 * so a test can hold the fence on one in-memory database and prove the bounded
 * reader refuses without also having to satisfy the reader's own query shape.
 */
export function fenceControlDatabaseReads(
  fence: D1Database,
  reads: ReadOnlyD1Database,
): FencedControlDatabase {
  return fencedDatabase(fence, reads);
}

function fencedDatabase(
  fence: D1Database,
  reads: ReadOnlyD1Database,
): FencedControlDatabase {
  const admit = () => assertControlD1MaintenanceInactive(fence);
  return {
    prepare(query: string) {
      return fencedStatement(admit, reads.prepare(query));
    },
  } as FencedControlDatabase;
}

function fencedStatement(
  admit: () => Promise<void>,
  statement: ReadOnlyD1PreparedStatement,
): ReadOnlyD1PreparedStatement {
  return {
    bind(...values: readonly unknown[]) {
      return fencedStatement(admit, statement.bind(...values));
    },
    async all<T = unknown>() {
      // Durable evidence first, application rows second. The fence read is not
      // memoized here: an operator can acquire the fence after an isolate has
      // warmed, so every bounded read obtains fresh evidence exactly like the
      // store's own request path does.
      await admit();
      return await statement.all<T>();
    },
  };
}
