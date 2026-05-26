# Reference Kind Packages {#kind-packages}

Takosumi manifests choose a component with `kind`. In the reference implementation, each kind's descriptor, TypeScript helpers, validator, and optional KernelPlugin factory live in a **kind package**. Package names use `@takos/takosumi-kind-<alias>`.

Repository ownership is split. Portable kind packages stay in `takosumi/`; backend-specific native kind packages live in `takosumi-plugins/`. Both keep the `@takos/takosumi-kind-*` package naming convention.

Portable kinds define the shared author-facing contract. Native kinds define concrete backend behavior. If a backend needs its own fields or outputs, use a native kind instead of adding a `provider` field to the manifest.

## Portable Kind Packages

| Package                             | kind alias     |
| ----------------------------------- | -------------- |
| `@takos/takosumi-kind-worker`       | `worker`       |
| `@takos/takosumi-kind-web-service`  | `web-service`  |
| `@takos/takosumi-kind-postgres`     | `postgres`     |
| `@takos/takosumi-kind-object-store` | `object-store` |
| `@takos/takosumi-kind-gateway`      | `gateway`      |

Portable descriptor packages live under `takosumi/packages/kind-*`. Operators may map a portable alias to a native kind, or directly implement the portable kind URI.

## Native Worker Packages

Native package source lives under `takosumi-plugins/packages/kind-*`.

| Package                                   | kind alias           |
| ----------------------------------------- | -------------------- |
| `@takos/takosumi-kind-cloudflare-worker`  | `cloudflare-worker`  |
| `@takos/takosumi-kind-deno-deploy-worker` | `deno-deploy-worker` |

## Native Web-Service Packages

| Package                                                 | kind alias                         |
| ------------------------------------------------------- | ---------------------------------- |
| `@takos/takosumi-kind-aws-fargate-web-service`          | `aws-fargate-web-service`          |
| `@takos/takosumi-kind-gcp-cloud-run-web-service`        | `gcp-cloud-run-web-service`        |
| `@takos/takosumi-kind-kubernetes-web-service`           | `kubernetes-web-service`           |
| `@takos/takosumi-kind-docker-compose-web-service`       | `docker-compose-web-service`       |
| `@takos/takosumi-kind-systemd-web-service`              | `systemd-web-service`              |
| `@takos/takosumi-kind-cloudflare-container-web-service` | `cloudflare-container-web-service` |
| `@takos/takosumi-kind-azure-container-apps-web-service` | `azure-container-apps-web-service` |

## Native Data Packages

| Package                                       | kind alias               |
| --------------------------------------------- | ------------------------ |
| `@takos/takosumi-kind-aws-rds-postgres`       | `aws-rds-postgres`       |
| `@takos/takosumi-kind-gcp-cloud-sql-postgres` | `gcp-cloud-sql-postgres` |
| `@takos/takosumi-kind-docker-postgres`        | `docker-postgres`        |

| Package                                           | kind alias                   |
| ------------------------------------------------- | ---------------------------- |
| `@takos/takosumi-kind-cloudflare-r2-object-store` | `cloudflare-r2-object-store` |
| `@takos/takosumi-kind-aws-s3-object-store`        | `aws-s3-object-store`        |
| `@takos/takosumi-kind-gcp-gcs-object-store`       | `gcp-gcs-object-store`       |
| `@takos/takosumi-kind-minio-object-store`         | `minio-object-store`         |
| `@takos/takosumi-kind-filesystem-object-store`    | `filesystem-object-store`    |

## Native Gateway Packages

| Package                                       | kind alias               |
| --------------------------------------------- | ------------------------ |
| `@takos/takosumi-kind-cloudflare-dns-gateway` | `cloudflare-dns-gateway` |
| `@takos/takosumi-kind-aws-route53-gateway`    | `aws-route53-gateway`    |
| `@takos/takosumi-kind-gcp-cloud-dns-gateway`  | `gcp-cloud-dns-gateway`  |
| `@takos/takosumi-kind-coredns-gateway`        | `coredns-gateway`        |

## Reference Adapter Exports

Native kind packages export a factory that returns a `KernelPlugin`. The plugin advertises concrete kind URIs through `provides[]`.

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import {
  cloudflareWorkerPlugin,
  KIND_URI as WORKER_KIND,
} from "@takos/takosumi-kind-cloudflare-worker";
import {
  awsRdsPostgresPlugin,
  KIND_URI as DB_KIND,
} from "@takos/takosumi-kind-aws-rds-postgres";

const { app } = await createPaaSApp({
  kindAliases: {
    worker: WORKER_KIND,
    postgres: DB_KIND,
  },
  plugins: [
    cloudflareWorkerPlugin({ accountId }),
    awsRdsPostgresPlugin({ region: "us-east-1" }),
  ],
});
```

`plugins` is the reference kernel's implementation mechanism. Compatible implementations may bind the same kind URI with a native controller, static registry, workflow engine, or SaaS adapter.

## Ownership Rule

- The descriptor source for a kind package is `spec/kind.jsonld`.
- Portable descriptor source lives under `takosumi/packages/kind-*`; native descriptor source lives under `takosumi-plugins/packages/kind-*`.
- The public package identity is `@takos/takosumi-kind-<alias>`.
- The operator's `kindAliases` decides which aliases are active.
- A backend-specific `spec` or material output should be a native kind package.

## Related Pages

- [Manifest](./manifest.md)
- [Kind Catalog](./type-catalog.md)
- [Extending Takosumi](../extending.md)
