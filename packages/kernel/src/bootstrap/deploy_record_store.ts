import type { RegisterDeployPublicRoutesOptions } from "../api/deploy_public_routes.ts";
import type { AppContext } from "../app_context.ts";
import type { SqlClient } from "../adapters/storage/sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "../domains/deploy/takosumi_deployment_record_store_sql.ts";

export interface ResolveDeploymentRecordStoreOptions {
  readonly takosumiDeploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly sqlClient?: SqlClient;
}

/**
 * Resolve the takosumi deploy record store the artifact + public deploy
 * routes share. Preference order:
 *   1. Caller-supplied `takosumiDeploymentRecordStore` — wins so tests
 *      can inject a fake without standing up SQL.
 *   2. `sqlClient` — when present, instantiate a SQL-backed store so the
 *      `(tenantId, name) → applied[]` mapping survives kernel restarts
 *      and the artifact GC reads from the live table.
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
    return new SqlTakosumiDeploymentRecordStore({ client: options.sqlClient });
  }
  return new InMemoryTakosumiDeploymentRecordStore();
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
  readonly recordStore: TakosumiDeploymentRecordStore;
}): RegisterDeployPublicRoutesOptions {
  return {
    appContext: input.context,
    getDeployToken: () => input.deployToken,
    recordStore: input.recordStore,
  };
}
