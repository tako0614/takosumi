/**
 * `@takos/takosumi-gcp-providers` — GCP-backed `KernelPlugin` factories
 * for the canonical Takosumi component kinds.
 *
 * Phase D extracted these factories out of `@takos/takosumi-plugins/bundled`
 * so Takosumi core no longer carries cloud-coupled imports. Operators that
 * want GCP provider coverage explicitly import this package and pass the
 * factory results into `createPaaSApp({ plugins: [...] })`.
 *
 * Exports:
 *   - `gcpCloudRunWorkerProvider`     → `worker@v1` (GCP Cloud Run)
 *   - `gcpGcsObjectStoreProvider`     → `object-store@v1` (GCP GCS)
 *   - `gcpCloudSqlPostgresProvider`   → `postgres@v1` (GCP Cloud SQL)
 */

export {
  gcpCloudRunWorkerProvider,
  type GcpCloudRunWorkerProviderOptions,
} from "./src/worker-gcp-cloud-run.ts";
export {
  gcpGcsObjectStoreProvider,
  type GcpGcsProviderOptions,
} from "./src/object-store-gcp-gcs.ts";
export {
  gcpCloudSqlPostgresProvider,
  type GcpCloudSqlProviderOptions,
} from "./src/postgres-gcp-cloud-sql.ts";
