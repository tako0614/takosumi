# Reference Kind Packages {#kind-packages}

Takosumi core is kind-agnostic. Manifests choose a component with `kind`, and operator distributions supply the catalog, aliases, and implementation bindings. Each kind's descriptor, TypeScript helpers, and validator live in a **kind package**. Backend-specific native kind packages may also export a `KernelPlugin` factory for the reference kernel. That is reference implementation wiring, not a required AppSpec mechanism. Package names use `@takos/takosumi-kind-<alias>`.

Repository ownership is split. Portable kind packages stay in `takosumi/`; backend-specific native kind packages live in `takosumi-plugins/`. Both keep the `@takos/takosumi-kind-*` package naming convention.

Portable kinds define the shared author-facing contract. Native kinds define concrete backend behavior. If a backend needs its own fields or outputs, use a native kind instead of adding a `provider` field to the manifest.

## Portable Kind Packages

| Package                              | kind alias      |
| ------------------------------------ | --------------- |
| `@takos/takosumi-kind-worker`        | `worker`        |
| `@takos/takosumi-kind-web-service`   | `web-service`   |
| `@takos/takosumi-kind-postgres`      | `postgres`      |
| `@takos/takosumi-kind-sqlite`        | `sqlite`        |
| `@takos/takosumi-kind-object-store`  | `object-store`  |
| `@takos/takosumi-kind-kv-store`      | `kv-store`      |
| `@takos/takosumi-kind-message-queue` | `message-queue` |
| `@takos/takosumi-kind-vector-store`  | `vector-store`  |
| `@takos/takosumi-kind-gateway`       | `gateway`       |

Portable descriptor packages live under `takosumi/packages/kind-*`. Their descriptors define portable `spec` vocabulary, output slots, and connection compatibility. An alias is only a shortcut to a URI. The resolved kind URI owns the `spec` schema, output slots, and connection compatibility. When a portable alias resolves to a portable URI, the operator attaches a binding that provides that portable URI. An alias that resolves to a native kind URI selects that native schema.

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

| Package                                                  | kind alias                          | family          |
| -------------------------------------------------------- | ----------------------------------- | --------------- |
| `@takos/takosumi-kind-aws-rds-postgres`                  | `aws-rds-postgres`                  | `postgres`      |
| `@takos/takosumi-kind-gcp-cloud-sql-postgres`            | `gcp-cloud-sql-postgres`            | `postgres`      |
| `@takos/takosumi-kind-docker-postgres`                   | `docker-postgres`                   | `postgres`      |
| `@takos/takosumi-kind-cloudflare-d1-sqlite`              | `cloudflare-d1-sqlite`              | `sqlite`        |
| `@takos/takosumi-kind-cloudflare-r2-object-store`        | `cloudflare-r2-object-store`        | `object-store`  |
| `@takos/takosumi-kind-aws-s3-object-store`               | `aws-s3-object-store`               | `object-store`  |
| `@takos/takosumi-kind-gcp-gcs-object-store`              | `gcp-gcs-object-store`              | `object-store`  |
| `@takos/takosumi-kind-minio-object-store`                | `minio-object-store`                | `object-store`  |
| `@takos/takosumi-kind-filesystem-object-store`           | `filesystem-object-store`           | `object-store`  |
| `@takos/takosumi-kind-cloudflare-kv-store`               | `cloudflare-kv-store`               | `kv-store`      |
| `@takos/takosumi-kind-cloudflare-queue-message-queue`    | `cloudflare-queue-message-queue`    | `message-queue` |
| `@takos/takosumi-kind-cloudflare-vectorize-vector-store` | `cloudflare-vectorize-vector-store` | `vector-store`  |

## Native Gateway Packages

| Package                                       | kind alias               |
| --------------------------------------------- | ------------------------ |
| `@takos/takosumi-kind-cloudflare-dns-gateway` | `cloudflare-dns-gateway` |
| `@takos/takosumi-kind-aws-route53-gateway`    | `aws-route53-gateway`    |
| `@takos/takosumi-kind-gcp-cloud-dns-gateway`  | `gcp-cloud-dns-gateway`  |
| `@takos/takosumi-kind-coredns-gateway`        | `coredns-gateway`        |

Native gateway packages may provide implementation bindings that materialize HTTP reachability. The portable `gateway` route vocabulary is defined in the [Official Catalog](./catalog.md#gateway-portable-subset). `routes[].to` points at a local `connect` binding key. Native packages can add concrete DNS, listener, TLS, and route-support constraints.

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

const workerLifecycle = createCloudflareWorkersLifecycleClient({ accountId });
const databaseLifecycle = createAwsRdsLifecycleClient({
  region: "us-east-1",
});

const { app } = await createPaaSApp({
  kindAliases: {
    "cloudflare-worker": WORKER_KIND,
    "aws-rds-postgres": DB_KIND,
  },
  plugins: [
    cloudflareWorkerPlugin({ accountId, lifecycle: workerLifecycle }),
    awsRdsPostgresPlugin({
      region: "us-east-1",
      lifecycle: databaseLifecycle,
    }),
  ],
});
```

`plugins` is the reference kernel's implementation mechanism. Compatible implementations may bind the same kind URI with a native controller, static registry, workflow engine, or SaaS adapter.

## Ownership Rule

- The descriptor source for a kind package is `spec/kind.jsonld`; JSON-LD is catalog metadata, not a runtime plugin requirement.
- Portable descriptor source lives under `takosumi/packages/kind-*`; native descriptor source lives under `takosumi-plugins/packages/kind-*`.
- The public package identity is `@takos/takosumi-kind-<alias>`.
- The operator's `kindAliases` decides which aliases are active.
- The resolved kind URI owns the `spec` schema, output slots, and connection compatibility.
- A backend-specific `spec` or material output should be a native kind package.

## Related Pages

- [Manifest](./manifest.md)
- [Official Catalog](./catalog.md)
- [Kind Binding Implementations](./kind-bindings.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Extending Takosumi](../extending.md)
