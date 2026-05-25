/**
 * `@takos/takosumi-selfhost-providers` — Self-host-backed `KernelPlugin`
 * factories for operator-opt-in takosumi.com reference kind URIs.
 *
 * Phase D extracted these factories out of `@takos/takosumi-plugins` reference registry
 * so Takosumi core no longer carries cloud / self-host coupled imports.
 * Operators that want a credential-free self-hosted Takosumi stack import
 * this package explicitly and pass the factory results into
 * `createPaaSApp({ kindAliases, plugins: [...] })`.
 *
 * Exports:
 *   - `selfhostDockerComposeWebServiceProvider` → `web-service@v1` (Docker Compose)
 *   - `selfhostSystemdWebServiceProvider`       → `web-service@v1` (systemd unit)
 *   - `selfhostMinioObjectStoreProvider`      → `object-store@v1` (MinIO)
 *   - `selfhostFilesystemObjectStoreProvider` → `object-store@v1` (local fs)
 *   - `selfhostPostgresProvider`              → `postgres@v1` (local Docker)
 *   - `selfhostCoreDnsGatewayProvider`        → `gateway@v1` (CoreDNS)
 */

export {
  selfhostDockerComposeWebServiceProvider,
  type SelfhostDockerComposeWebServiceProviderOptions,
  selfhostDockerComposeWorkerProvider,
  type SelfhostDockerComposeWorkerProviderOptions,
} from "./src/worker-selfhost-docker-compose.ts";
export {
  selfhostSystemdWebServiceProvider,
  type SelfhostSystemdWebServiceProviderOptions,
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
export {
  selfhostCoreDnsGatewayProvider,
  type SelfhostCoreDnsGatewayProviderOptions,
} from "./src/gateway-selfhost-coredns.ts";
