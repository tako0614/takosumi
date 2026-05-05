import type { RegisterDeployPublicRoutesOptions } from "../api/deploy_public_routes.ts";
import type { AppContext } from "../app_context.ts";
import type { SqlClient } from "../adapters/storage/sql.ts";
import {
  createExecutableCatalogHookRunner,
  type ExecutableCatalogHookPackage,
} from "../plugins/executable_hooks.ts";
import {
  type DeployPublicIdempotencyStore,
  InMemoryDeployPublicIdempotencyStore,
} from "../domains/deploy/deploy_public_idempotency_store.ts";
import { SqlDeployPublicIdempotencyStore } from "../domains/deploy/deploy_public_idempotency_store_sql.ts";
import {
  InMemoryOperationJournalStore,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import { SqlOperationJournalStore } from "../domains/deploy/operation_journal_sql.ts";
import {
  InMemoryRevokeDebtStore,
  type RevokeDebtStore,
} from "../domains/deploy/revoke_debt_store.ts";
import { SqlRevokeDebtStore } from "../domains/deploy/revoke_debt_store_sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "../domains/deploy/takosumi_deployment_record_store_sql.ts";

export interface ResolveDeploymentRecordStoreOptions {
  readonly takosumiDeploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly takosumiDeployIdempotencyStore?: DeployPublicIdempotencyStore;
  readonly takosumiOperationJournalStore?: OperationJournalStore;
  readonly takosumiRevokeDebtStore?: RevokeDebtStore;
  readonly sqlClient?: SqlClient;
  readonly deployLockLeaseMs?: number;
  readonly deployLockHeartbeatMs?: number;
}

/**
 * Resolve the takosumi deploy record store the artifact + public deploy
 * routes share. Preference order:
 *   1. Caller-supplied `takosumiDeploymentRecordStore` — wins so tests
 *      can inject a fake without standing up SQL.
 *   2. `sqlClient` — when present, instantiate a SQL-backed store so the
 *      `(tenantId, name) → applied[]` mapping survives kernel restarts,
 *      the deploy lock is shared across kernel pods, and artifact GC
 *      reads from the live table.
 *   3. In-memory fallback — fine for single-process dev and the test
 *      suite, but loses every record on process exit.
 *
 * The same store instance is passed to both artifact routes and deploy
 * public routes so the artifact GC's "what is still referenced?" query
 * always agrees with the route that just persisted the record.
 */
export function resolveTakosumiDeploymentRecordStore(
  options: ResolveDeploymentRecordStoreOptions,
): TakosumiDeploymentRecordStore {
  if (options.takosumiDeploymentRecordStore) {
    return options.takosumiDeploymentRecordStore;
  }
  if (options.sqlClient) {
    return new SqlTakosumiDeploymentRecordStore({
      client: options.sqlClient,
      ...(options.deployLockLeaseMs !== undefined
        ? { lockLeaseMs: options.deployLockLeaseMs }
        : {}),
      ...(options.deployLockHeartbeatMs !== undefined
        ? { lockHeartbeatMs: options.deployLockHeartbeatMs }
        : {}),
    });
  }
  return new InMemoryTakosumiDeploymentRecordStore();
}

/**
 * Resolve the public deploy idempotency replay store. Production follows
 * the same SQL preference as deployment records so a kernel restart does
 * not turn a retried `X-Idempotency-Key` into a second provider operation.
 */
export function resolveDeployPublicIdempotencyStore(
  options: ResolveDeploymentRecordStoreOptions,
): DeployPublicIdempotencyStore {
  if (options.takosumiDeployIdempotencyStore) {
    return options.takosumiDeployIdempotencyStore;
  }
  if (options.sqlClient) {
    return new SqlDeployPublicIdempotencyStore({ client: options.sqlClient });
  }
  return new InMemoryDeployPublicIdempotencyStore();
}

/**
 * Resolve the WAL stage journal used by the public deploy route. Production
 * follows the SQL preference so OperationPlan stage records survive restarts
 * and can be inspected during recovery; dev/test falls back to memory.
 */
export function resolveOperationJournalStore(
  options: ResolveDeploymentRecordStoreOptions,
): OperationJournalStore {
  if (options.takosumiOperationJournalStore) {
    return options.takosumiOperationJournalStore;
  }
  if (options.sqlClient) {
    return new SqlOperationJournalStore({ client: options.sqlClient });
  }
  return new InMemoryOperationJournalStore();
}

/**
 * Resolve the RevokeDebt store. Production follows the SQL preference because
 * compensation debt is recovery-critical and must remain visible after
 * process restarts; dev/test falls back to memory.
 */
export function resolveRevokeDebtStore(
  options: ResolveDeploymentRecordStoreOptions,
): RevokeDebtStore {
  if (options.takosumiRevokeDebtStore) {
    return options.takosumiRevokeDebtStore;
  }
  if (options.sqlClient) {
    return new SqlRevokeDebtStore({ client: options.sqlClient });
  }
  return new InMemoryRevokeDebtStore();
}

/**
 * Materialise the public deploy route options that bootstrap forwards to
 * `createApiApp` so the kernel mounts `POST /v1/deployments`. The route
 * needs (a) the deploy token, (b) an `appContext` to derive its
 * `PlatformContext` from, and (c) the shared record store. Returning
 * `undefined` from the caller's branch disables the mount entirely.
 */
export function buildDeployPublicRouteOptions(input: {
  readonly context: AppContext;
  readonly deployToken: string;
  readonly deploySpaceId?: string;
  readonly recordStore: TakosumiDeploymentRecordStore;
  readonly idempotencyStore: DeployPublicIdempotencyStore;
  readonly operationJournalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
  readonly catalogHookPackages?: readonly ExecutableCatalogHookPackage[];
}): RegisterDeployPublicRoutesOptions {
  const hookRunner = input.catalogHookPackages?.length
    ? createExecutableCatalogHookRunner(input.catalogHookPackages)
    : undefined;
  const catalogReleaseVerifier = hookRunner
    ? {
      verifyCurrentReleaseForSpace: (spaceId: string) =>
        input.context.services.registry.catalogReleases
          .verifyCurrentReleaseForSpace(spaceId),
      runExecutableHooks: hookRunner.runExecutableHooks,
    }
    : input.context.services.registry.catalogReleases;
  return {
    appContext: input.context,
    getDeployToken: () => input.deployToken,
    ...(input.deploySpaceId ? { tenantId: input.deploySpaceId } : {}),
    recordStore: input.recordStore,
    idempotencyStore: input.idempotencyStore,
    operationJournalStore: input.operationJournalStore,
    revokeDebtStore: input.revokeDebtStore,
    catalogReleaseVerifier,
  };
}
