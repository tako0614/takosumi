/**
 * Phase H import smoke — verify each cloud provider package re-exports a
 * `KernelPlugin` factory that satisfies the reference materializer surface and is
 * attachable to `createPaaSApp({ kindAliases, plugins })`.
 *
 * Goal: kernel core (`packages/kernel/`) has no cloud SDK import, but the
 * reference provider and external adapter plugin packages exist as separate
 * workspace members and the factories can be imported + invoked without
 * erroring. No real cloud API is called — the in-memory defaults exercised
 * here keep the smoke offline.
 *
 * Run from `takosumi/`:
 *
 *   deno run --allow-all scripts/_phase-h-cloud-providers-import-smoke.ts
 *
 * Also executed as a deno test under
 * `scripts/_phase-h-cloud-providers-import-smoke_test.ts` so the assertion
 * enters the standard `deno test` count.
 */

import {
  cloudflareCustomDomainProvider,
  cloudflareR2ObjectStoreProvider,
  cloudflareWorkerProvider,
} from "../packages/cloudflare-providers/mod.ts";
import {
  awsFargateWebServiceProvider,
  awsRdsPostgresProvider,
  awsRoute53CustomDomainProvider,
  awsS3ObjectStoreProvider,
} from "../packages/aws-providers/mod.ts";
import {
  gcpCloudRunWebServiceProvider,
  gcpCloudSqlPostgresProvider,
  gcpGcsObjectStoreProvider,
} from "../packages/gcp-providers/mod.ts";
import { kubernetesWebServiceProvider } from "../packages/kubernetes-providers/mod.ts";
import { denoDeployWorkerProvider } from "../packages/deno-deploy-providers/mod.ts";
import {
  dockerComposeWebServiceProvider,
} from "../packages/plugin-web-service-docker-compose/mod.ts";
import {
  filesystemObjectStoreProvider,
} from "../packages/plugin-object-store-filesystem/mod.ts";
import {
  coreDnsGatewayProvider,
} from "../packages/plugin-gateway-coredns/mod.ts";
import {
  minioObjectStoreProvider,
} from "../packages/plugin-object-store-minio/mod.ts";
import {
  dockerPostgresProvider,
} from "../packages/plugin-postgres-docker/mod.ts";
import {
  systemdWebServiceProvider,
} from "../packages/plugin-web-service-systemd/mod.ts";

import type { KernelPlugin } from "../packages/contract/src/plugin.ts";

export interface CloudProviderRow {
  readonly pkg: string;
  readonly factory: string;
  readonly plugin: KernelPlugin;
}

export const CLOUD_PROVIDER_ROWS: readonly CloudProviderRow[] = [
  {
    pkg: "cloudflare",
    factory: "cloudflareWorkerProvider",
    plugin: cloudflareWorkerProvider(),
  },
  {
    pkg: "cloudflare",
    factory: "cloudflareR2ObjectStoreProvider",
    plugin: cloudflareR2ObjectStoreProvider(),
  },
  {
    pkg: "cloudflare",
    factory: "cloudflareCustomDomainProvider",
    plugin: cloudflareCustomDomainProvider(),
  },
  {
    pkg: "aws",
    factory: "awsFargateWebServiceProvider",
    plugin: awsFargateWebServiceProvider(),
  },
  {
    pkg: "aws",
    factory: "awsS3ObjectStoreProvider",
    plugin: awsS3ObjectStoreProvider(),
  },
  {
    pkg: "aws",
    factory: "awsRdsPostgresProvider",
    plugin: awsRdsPostgresProvider(),
  },
  {
    pkg: "aws",
    factory: "awsRoute53CustomDomainProvider",
    plugin: awsRoute53CustomDomainProvider(),
  },
  {
    pkg: "gcp",
    factory: "gcpCloudRunWebServiceProvider",
    plugin: gcpCloudRunWebServiceProvider(),
  },
  {
    pkg: "gcp",
    factory: "gcpGcsObjectStoreProvider",
    plugin: gcpGcsObjectStoreProvider(),
  },
  {
    pkg: "gcp",
    factory: "gcpCloudSqlPostgresProvider",
    plugin: gcpCloudSqlPostgresProvider(),
  },
  {
    pkg: "kubernetes",
    factory: "kubernetesWebServiceProvider",
    plugin: kubernetesWebServiceProvider(),
  },
  {
    pkg: "deno-deploy",
    factory: "denoDeployWorkerProvider",
    plugin: denoDeployWorkerProvider(),
  },
  {
    pkg: "docker-compose",
    factory: "dockerComposeWebServiceProvider",
    plugin: dockerComposeWebServiceProvider(),
  },
  {
    pkg: "systemd",
    factory: "systemdWebServiceProvider",
    plugin: systemdWebServiceProvider(),
  },
  {
    pkg: "minio",
    factory: "minioObjectStoreProvider",
    plugin: minioObjectStoreProvider(),
  },
  {
    pkg: "filesystem",
    factory: "filesystemObjectStoreProvider",
    plugin: filesystemObjectStoreProvider(),
  },
  {
    pkg: "docker-postgres",
    factory: "dockerPostgresProvider",
    plugin: dockerPostgresProvider(),
  },
  {
    pkg: "coredns",
    factory: "coreDnsGatewayProvider",
    plugin: coreDnsGatewayProvider({ defaultHost: "app.test" }),
  },
];

export function isValidKernelPlugin(plugin: unknown): boolean {
  return typeof plugin === "object" &&
    plugin !== null &&
    typeof (plugin as { name?: unknown }).name === "string" &&
    typeof (plugin as { version?: unknown }).version === "string" &&
    Array.isArray((plugin as { provides?: unknown }).provides) &&
    (plugin as { provides: readonly unknown[] }).provides.length > 0 &&
    typeof (plugin as { apply?: unknown }).apply === "function";
}

if (import.meta.main) {
  let bad = 0;
  for (const row of CLOUD_PROVIDER_ROWS) {
    const ok = isValidKernelPlugin(row.plugin);
    const tag = ok ? "OK" : "FAIL";
    if (!ok) bad += 1;
    const provides =
      (row.plugin as { provides?: readonly string[] }).provides ??
        [];
    const kindUris = provides.length > 0 ? provides.join(", ") : "(none)";
    console.log(
      `${tag}  ${row.pkg.padEnd(11)} ${
        row.factory.padEnd(45)
      } → kindUri: ${kindUris}`,
    );
  }
  console.log(
    `\nResult: ${
      CLOUD_PROVIDER_ROWS.length - bad
    } ok, ${bad} failed (out of ${CLOUD_PROVIDER_ROWS.length})`,
  );
  if (bad > 0) Deno.exit(1);
}
