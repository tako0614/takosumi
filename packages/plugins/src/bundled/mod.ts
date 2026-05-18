/**
 * Bundled KernelPlugin factories — operator-facing entry for the
 * Takosumi-shipped set of provider connectors. Each factory returns a
 * `KernelPlugin` ready to drop into the plain-array `plugins` option of
 * `createPaaSApp({ plugins: [...] })`.
 *
 * The 5 canonical kinds (worker / postgres / object-store / oidc /
 * custom-domain) each have at least one bundled factory. Operators that
 * want a turnkey kernel can call `defaultBundledPlugins()` for a
 * self-host-friendly default set; everything beyond that is opt-in.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";

export {
  cloudflareWorkerProvider,
  type CloudflareWorkerProviderOptions,
} from "./worker-cloudflare.ts";
export {
  denoDeployWorkerProvider,
  type DenoDeployWorkerProviderOptions,
} from "./worker-deno-deploy.ts";
export {
  awsFargateWorkerProvider,
  type AwsFargateWorkerProviderOptions,
} from "./worker-aws-fargate.ts";
export {
  gcpCloudRunWorkerProvider,
  type GcpCloudRunWorkerProviderOptions,
} from "./worker-gcp-cloud-run.ts";
export {
  kubernetesWorkerProvider,
  type KubernetesWorkerProviderOptions,
} from "./worker-kubernetes.ts";
export {
  selfhostDockerComposeWorkerProvider,
  type SelfhostDockerComposeWorkerProviderOptions,
} from "./worker-selfhost-docker-compose.ts";
export {
  selfhostSystemdWorkerProvider,
  type SelfhostSystemdWorkerProviderOptions,
} from "./worker-selfhost-systemd.ts";
export {
  awsS3ObjectStoreProvider,
  type AwsS3ProviderOptions,
} from "./object-store-aws-s3.ts";
export {
  cloudflareR2ObjectStoreProvider,
  type CloudflareR2ProviderOptions,
} from "./object-store-cloudflare-r2.ts";
export {
  gcpGcsObjectStoreProvider,
  type GcpGcsProviderOptions,
} from "./object-store-gcp-gcs.ts";
export {
  selfhostMinioObjectStoreProvider,
  type SelfhostMinioProviderOptions,
} from "./object-store-selfhost-minio.ts";
export {
  selfhostFilesystemObjectStoreProvider,
  type SelfhostFilesystemProviderOptions,
} from "./object-store-selfhost-filesystem.ts";
export {
  awsRdsPostgresProvider,
  type AwsRdsPostgresProviderOptions,
} from "./postgres-aws-rds.ts";
export {
  gcpCloudSqlPostgresProvider,
  type GcpCloudSqlProviderOptions,
} from "./postgres-gcp-cloud-sql.ts";
export {
  selfhostPostgresProvider,
  type SelfhostPostgresProviderOptions,
} from "./postgres-selfhost.ts";
export {
  InMemoryTakosumiAccountsOidcClient,
  type TakosumiAccountsOidcClient,
  takosumiAccountsOidcProvider,
  type TakosumiAccountsOidcProviderOptions,
} from "./oidc-takosumi-accounts.ts";
export {
  cloudflareCustomDomainProvider,
  type CloudflareCustomDomainProviderOptions,
} from "./custom-domain-cloudflare.ts";
export {
  awsRoute53CustomDomainProvider,
  type AwsRoute53ProviderOptions,
} from "./custom-domain-aws-route53.ts";

import { selfhostDockerComposeWorkerProvider } from "./worker-selfhost-docker-compose.ts";
import { selfhostFilesystemObjectStoreProvider } from "./object-store-selfhost-filesystem.ts";
import { selfhostPostgresProvider } from "./postgres-selfhost.ts";
import { takosumiAccountsOidcProvider } from "./oidc-takosumi-accounts.ts";
import { cloudflareCustomDomainProvider } from "./custom-domain-cloudflare.ts";
import { cloudflareWorkerProvider } from "./worker-cloudflare.ts";
import { awsFargateWorkerProvider } from "./worker-aws-fargate.ts";
import { gcpCloudRunWorkerProvider } from "./worker-gcp-cloud-run.ts";
import { kubernetesWorkerProvider } from "./worker-kubernetes.ts";
import { selfhostSystemdWorkerProvider } from "./worker-selfhost-systemd.ts";
import { denoDeployWorkerProvider } from "./worker-deno-deploy.ts";
import { awsS3ObjectStoreProvider } from "./object-store-aws-s3.ts";
import { cloudflareR2ObjectStoreProvider } from "./object-store-cloudflare-r2.ts";
import { gcpGcsObjectStoreProvider } from "./object-store-gcp-gcs.ts";
import { selfhostMinioObjectStoreProvider } from "./object-store-selfhost-minio.ts";
import { awsRdsPostgresProvider } from "./postgres-aws-rds.ts";
import { gcpCloudSqlPostgresProvider } from "./postgres-gcp-cloud-sql.ts";
import { awsRoute53CustomDomainProvider } from "./custom-domain-aws-route53.ts";

/**
 * Operator-facing options for `defaultBundledPlugins()`. By default the
 * function returns one provider per kind that's safe for self-hosted
 * usage (no cloud credentials required). Operators can opt-in to cloud
 * providers via the `enable*` flags, or build their own plain array by
 * importing the individual factory functions.
 */
export interface DefaultBundledPluginsOptions {
  /** Include the Cloudflare Workers worker provider. Default: false. */
  readonly enableCloudflareWorkers?: boolean;
  /** Include the AWS Fargate worker provider. Default: false. */
  readonly enableAwsFargate?: boolean;
  /** Include the GCP Cloud Run worker provider. Default: false. */
  readonly enableGcpCloudRun?: boolean;
  /** Include the Kubernetes worker provider. Default: false. */
  readonly enableKubernetes?: boolean;
  /** Include the SystemD worker provider. Default: false. */
  readonly enableSystemd?: boolean;
  /** Include the Deno Deploy worker provider. Default: false. */
  readonly enableDenoDeploy?: boolean;
  /** Include the AWS S3 object-store provider. Default: false. */
  readonly enableAwsS3?: boolean;
  /** Include the Cloudflare R2 object-store provider. Default: false. */
  readonly enableCloudflareR2?: boolean;
  /** Include the GCP GCS object-store provider. Default: false. */
  readonly enableGcpGcs?: boolean;
  /** Include the MinIO object-store provider. Default: false. */
  readonly enableMinio?: boolean;
  /** Include the AWS RDS postgres provider. Default: false. */
  readonly enableAwsRds?: boolean;
  /** Include the GCP Cloud SQL postgres provider. Default: false. */
  readonly enableGcpCloudSql?: boolean;
  /** Include the AWS Route53 custom-domain provider. Default: false. */
  readonly enableAwsRoute53?: boolean;
  /** Disable selfhost defaults (docker-compose / filesystem / postgres / cloudflare-dns / oidc). Default: false. */
  readonly disableSelfhost?: boolean;
}

/**
 * Return the bundled `KernelPlugin` set as a plain array.
 *
 * By default returns one provider per canonical kind that's safe for
 * self-hosted usage:
 *   - worker             → docker-compose
 *   - postgres           → local-docker
 *   - object-store       → filesystem
 *   - oidc               → Takosumi Accounts (in-memory client by default)
 *   - custom-domain      → Cloudflare DNS (in-memory client by default)
 *
 * Cloud providers are opt-in via the `enable*` flags so booting the
 * kernel without external credentials always works.
 */
export function defaultBundledPlugins(
  opts: DefaultBundledPluginsOptions = {},
): readonly KernelPlugin[] {
  const out: KernelPlugin[] = [];
  if (!opts.disableSelfhost) {
    out.push(selfhostDockerComposeWorkerProvider());
    out.push(selfhostFilesystemObjectStoreProvider());
    out.push(selfhostPostgresProvider());
    out.push(takosumiAccountsOidcProvider());
    out.push(cloudflareCustomDomainProvider());
  }
  if (opts.enableCloudflareWorkers) out.push(cloudflareWorkerProvider());
  if (opts.enableAwsFargate) out.push(awsFargateWorkerProvider());
  if (opts.enableGcpCloudRun) out.push(gcpCloudRunWorkerProvider());
  if (opts.enableKubernetes) out.push(kubernetesWorkerProvider());
  if (opts.enableSystemd) out.push(selfhostSystemdWorkerProvider());
  if (opts.enableDenoDeploy) out.push(denoDeployWorkerProvider());
  if (opts.enableAwsS3) out.push(awsS3ObjectStoreProvider());
  if (opts.enableCloudflareR2) out.push(cloudflareR2ObjectStoreProvider());
  if (opts.enableGcpGcs) out.push(gcpGcsObjectStoreProvider());
  if (opts.enableMinio) out.push(selfhostMinioObjectStoreProvider());
  if (opts.enableAwsRds) out.push(awsRdsPostgresProvider());
  if (opts.enableGcpCloudSql) out.push(gcpCloudSqlPostgresProvider());
  if (opts.enableAwsRoute53) out.push(awsRoute53CustomDomainProvider());
  return out;
}
