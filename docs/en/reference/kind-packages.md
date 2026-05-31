# Reference Kind Packages {#kind-packages}

Takosumi core is kind-agnostic. Manifests choose a component with `kind`, and operator distributions supply the catalog, aliases, and implementation bindings. Kind descriptors live in the **single official catalog** (`takosumi/docs/kinds/v1/*.jsonld`, published as `https://takosumi.com/kinds/v1/*`). Descriptors are not npm package exports.

Repository ownership is split. Official descriptors stay in `takosumi/docs/kinds/v1/`; backend-specific implementation modules live in `takosumi-plugins/packages/kind-*` and publish as `@takosjp/takosumi-plugins/kind/<alias>` subpaths.

Portable kinds define the shared author-facing contract. Native kinds define concrete backend behavior. If a backend needs its own fields or outputs, use a native kind instead of adding a `provider` field to the manifest.

## Official Catalog Descriptors

| Descriptor source                    | Published URI                                  | suggested alias |
| ------------------------------------ | ---------------------------------------------- | --------------- |
| `docs/kinds/v1/worker.jsonld`        | `https://takosumi.com/kinds/v1/worker`         | `worker`        |
| `docs/kinds/v1/web-service.jsonld`   | `https://takosumi.com/kinds/v1/web-service`    | `web-service`   |
| `docs/kinds/v1/postgres.jsonld`      | `https://takosumi.com/kinds/v1/postgres`       | `postgres`      |
| `docs/kinds/v1/sqlite.jsonld`        | `https://takosumi.com/kinds/v1/sqlite`         | `sqlite`        |
| `docs/kinds/v1/object-store.jsonld`  | `https://takosumi.com/kinds/v1/object-store`   | `object-store`  |
| `docs/kinds/v1/kv-store.jsonld`      | `https://takosumi.com/kinds/v1/kv-store`       | `kv-store`      |
| `docs/kinds/v1/message-queue.jsonld` | `https://takosumi.com/kinds/v1/message-queue`  | `message-queue` |
| `docs/kinds/v1/vector-store.jsonld`  | `https://takosumi.com/kinds/v1/vector-store`   | `vector-store`  |
| `docs/kinds/v1/gateway.jsonld`       | `https://takosumi.com/kinds/v1/gateway`        | `gateway`       |

Base kind descriptors live in the single catalog `takosumi/docs/kinds/v1/` and define portable `spec` vocabulary, output slots, and connection compatibility. An alias is only a shortcut to a URI. The resolved kind URI owns the `spec` schema, output slots, and connection compatibility. When a portable alias resolves to a portable URI, the operator attaches a binding that provides that portable URI. An alias that resolves to a native kind URI selects that native schema.

## Native Worker Packages

Native package source lives under `takosumi-plugins/packages/kind-*`.

| Package                                             | kind alias           |
| --------------------------------------------------- | -------------------- |
| `@takosjp/takosumi-plugins/kind/cloudflare-worker`  | `cloudflare-worker`  |
| `@takosjp/takosumi-plugins/kind/deno-deploy-worker` | `deno-deploy-worker` |

## Native Web-Service Packages

| Package                                                           | kind alias                         |
| ----------------------------------------------------------------- | ---------------------------------- |
| `@takosjp/takosumi-plugins/kind/aws-fargate-web-service`          | `aws-fargate-web-service`          |
| `@takosjp/takosumi-plugins/kind/gcp-cloud-run-web-service`        | `gcp-cloud-run-web-service`        |
| `@takosjp/takosumi-plugins/kind/kubernetes-web-service`           | `kubernetes-web-service`           |
| `@takosjp/takosumi-plugins/kind/docker-compose-web-service`       | `docker-compose-web-service`       |
| `@takosjp/takosumi-plugins/kind/systemd-web-service`              | `systemd-web-service`              |
| `@takosjp/takosumi-plugins/kind/cloudflare-container-web-service` | `cloudflare-container-web-service` |
| `@takosjp/takosumi-plugins/kind/azure-container-apps-web-service` | `azure-container-apps-web-service` |

## Native Data Packages

| Package                                                            | kind alias                          | family          |
| ------------------------------------------------------------------ | ----------------------------------- | --------------- |
| `@takosjp/takosumi-plugins/kind/aws-rds-postgres`                  | `aws-rds-postgres`                  | `postgres`      |
| `@takosjp/takosumi-plugins/kind/gcp-cloud-sql-postgres`            | `gcp-cloud-sql-postgres`            | `postgres`      |
| `@takosjp/takosumi-plugins/kind/docker-postgres`                   | `docker-postgres`                   | `postgres`      |
| `@takosjp/takosumi-plugins/kind/cloudflare-d1-sqlite`              | `cloudflare-d1-sqlite`              | `sqlite`        |
| `@takosjp/takosumi-plugins/kind/cloudflare-r2-object-store`        | `cloudflare-r2-object-store`        | `object-store`  |
| `@takosjp/takosumi-plugins/kind/aws-s3-object-store`               | `aws-s3-object-store`               | `object-store`  |
| `@takosjp/takosumi-plugins/kind/gcp-gcs-object-store`              | `gcp-gcs-object-store`              | `object-store`  |
| `@takosjp/takosumi-plugins/kind/minio-object-store`                | `minio-object-store`                | `object-store`  |
| `@takosjp/takosumi-plugins/kind/filesystem-object-store`           | `filesystem-object-store`           | `object-store`  |
| `@takosjp/takosumi-plugins/kind/cloudflare-kv-store`               | `cloudflare-kv-store`               | `kv-store`      |
| `@takosjp/takosumi-plugins/kind/cloudflare-queue-message-queue`    | `cloudflare-queue-message-queue`    | `message-queue` |
| `@takosjp/takosumi-plugins/kind/cloudflare-vectorize-vector-store` | `cloudflare-vectorize-vector-store` | `vector-store`  |

## Native Gateway Packages

| Package                                                 | kind alias               |
| ------------------------------------------------------- | ------------------------ |
| `@takosjp/takosumi-plugins/kind/cloudflare-dns-gateway` | `cloudflare-dns-gateway` |
| `@takosjp/takosumi-plugins/kind/aws-route53-gateway`    | `aws-route53-gateway`    |
| `@takosjp/takosumi-plugins/kind/gcp-cloud-dns-gateway`  | `gcp-cloud-dns-gateway`  |
| `@takosjp/takosumi-plugins/kind/coredns-gateway`        | `coredns-gateway`        |

Native gateway packages may provide implementation bindings that materialize HTTP reachability. The portable `gateway` route vocabulary is defined in the [Official Catalog](./catalog.md#gateway-portable-subset). `routes[].to` points at a local `connect` binding key. Native packages can add concrete DNS, listener, TLS, and route-support constraints.

## Reference Adapter Exports

Native kind packages export a factory that returns a `KernelPlugin`. The plugin advertises concrete kind URIs through `provides[]`.

```ts
import { createPaaSApp } from "@takosjp/takosumi/kernel";
import {
  cloudflareWorkerPlugin,
  KIND_URI as WORKER_KIND,
} from "@takosjp/takosumi-plugins/kind/cloudflare-worker";
import {
  awsRdsPostgresPlugin,
  KIND_URI as DB_KIND,
} from "@takosjp/takosumi-plugins/kind/aws-rds-postgres";

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

## Provider Live Proof

Local validation for native kind packages runs in `takosumi-plugins/` through
check, test, and publish dry-run tasks. Materialization proof against a real
provider is external operator evidence because it uses operator-owned
infrastructure and credentials. Takosumi provides the proof shape and a
credential-free fixture gate.

```sh
cd takosumi
bun run live-provisioning-smoke
```

The fixture gate validates AWS, GCP, Kubernetes, Cloudflare, self-host, and
external provider shapes. Live proof sends the same fixture to the operator's
provider gateway.

```sh
cd takosumi
TAKOSUMI_PLUGIN_LIVE_PROOF_MODE=live \
TAKOSUMI_PLUGIN_LIVE_PROVIDER=cloudflare \
TAKOSUMI_PLUGIN_LIVE_PROOF_FIXTURE_FILE=fixtures/live-provisioning/cloudflare.shape-v1.json \
TAKOSUMI_PLUGIN_GATEWAY_URL=https://<operator-provider-gateway> \
TAKOSUMI_PLUGIN_GATEWAY_BEARER_TOKEN=<operator-token> \
bun run live-provisioning-smoke
```

Canonical fixtures by provider:

| Provider   | Fixture                                               |
| ---------- | ----------------------------------------------------- |
| Cloudflare | `fixtures/live-provisioning/cloudflare.shape-v1.json` |
| self-host  | `fixtures/live-provisioning/selfhosted.shape-v1.json` |
| AWS        | `fixtures/live-provisioning/aws.shape-v1.json`        |
| GCP        | `fixtures/live-provisioning/gcp.shape-v1.json`        |
| Kubernetes | `fixtures/live-provisioning/kubernetes.shape-v1.json` |

Set `TAKOSUMI_PLUGIN_LIVE_CLEANUP_ONLY=1` to run teardown for the same desired
state. Store live reports in the operator's private evidence store, not in
public docs.

## Ownership Rule

- Every kind descriptor source lives in the single catalog `takosumi/docs/kinds/v1/`; `takosumi-plugins/packages/kind-*` holds implementations only (no descriptor source).
- Descriptor public identity is `https://takosumi.com/kinds/v1/<name>`. Backend-specific implementation public package identity is `@takosjp/takosumi-plugins/kind/<alias>`.
- The operator's `kindAliases` decides which aliases are active.
- The resolved kind URI owns the `spec` schema, output slots, and connection compatibility.
- A backend-specific `spec` or material output should be a native kind package.

## Related Pages

- [Manifest](./manifest.md)
- [Official Catalog](./catalog.md)
- [Kind Binding Implementations](./kind-bindings.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Extending Takosumi](../extending.md)
