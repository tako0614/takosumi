/**
 * `@takos/takosumi-selfhost-providers` — Self-host-backed `KernelPlugin`
 * factories for the canonical Takosumi component kinds.
 *
 * Phase D extracted these factories out of `@takos/takosumi-plugins/bundled`
 * so Takosumi core no longer carries cloud / self-host coupled imports.
 * Operators that want a credential-free self-hosted Takosumi stack import
 * this package explicitly and pass the factory results into
 * `createPaaSApp({ plugins: [...] })`.
 *
 * Exports:
 *   - `selfhostDockerComposeWorkerProvider`   → `worker@v1` (Docker Compose)
 *   - `selfhostSystemdWorkerProvider`         → `worker@v1` (systemd unit)
 *   - `selfhostMinioObjectStoreProvider`      → `object-store@v1` (MinIO)
 *   - `selfhostFilesystemObjectStoreProvider` → `object-store@v1` (local fs)
 *   - `selfhostPostgresProvider`              → `postgres@v1` (local Docker)
 */

export {
  selfhostDockerComposeWorkerProvider,
  type SelfhostDockerComposeWorkerProviderOptions,
} from "./src/worker-selfhost-docker-compose.ts";
export {
  selfhostSystemdWorkerProvider,
  type SelfhostSystemdWorkerProviderOptions,
} from "./src/worker-selfhost-systemd.ts";
export {
  selfhostMinioObjectStoreProvider,
  type SelfhostMinioProviderOptions,
} from "./src/object-store-selfhost-minio.ts";
export {
  selfhostFilesystemObjectStoreProvider,
  type SelfhostFilesystemProviderOptions,
} from "./src/object-store-selfhost-filesystem.ts";
export {
  selfhostPostgresProvider,
  type SelfhostPostgresProviderOptions,
} from "./src/postgres-selfhost.ts";
