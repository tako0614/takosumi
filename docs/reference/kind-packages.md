# Reference Kind Packages {#kind-packages}

Takosumi の manifest は `kind` だけで component の種類を選びます。Reference implementation では、各 kind の descriptor、TypeScript helper、validator、必要な KernelPlugin factory を **kind package** に置きます。package は `@takos/takosumi-kind-<alias>` です。

Repository ownership は二つに分かれます。portable kind package は `takosumi/` に残り、backend-specific native kind package は `takosumi-plugins/` に置きます。package 名はどちらも `@takos/takosumi-kind-*` を使います。

`worker` のような portable kind は共通最小契約です。`cloudflare-worker` のような native kind は substrate 固有契約です。backend 固有の field や output shape が必要なら native kind を使います。`provider` field は manifest にはありません。

## Portable kind packages

| Package                             | kind alias     |
| ----------------------------------- | -------------- |
| `@takos/takosumi-kind-worker`       | `worker`       |
| `@takos/takosumi-kind-web-service`  | `web-service`  |
| `@takos/takosumi-kind-postgres`     | `postgres`     |
| `@takos/takosumi-kind-object-store` | `object-store` |
| `@takos/takosumi-kind-gateway`      | `gateway`      |

Portable kind は `takosumi/packages/kind-*` の descriptor と helper を提供します。operator は portable alias を特定の native kind に map してもよいし、portable URI を直接 materialize する adapter を持ってもよいです。

## Native worker packages

Native package の source は `takosumi-plugins/packages/kind-*` です。

| Package                                   | kind alias           |
| ----------------------------------------- | -------------------- |
| `@takos/takosumi-kind-cloudflare-worker`  | `cloudflare-worker`  |
| `@takos/takosumi-kind-deno-deploy-worker` | `deno-deploy-worker` |

## Native web-service packages

| Package                                                 | kind alias                         |
| ------------------------------------------------------- | ---------------------------------- |
| `@takos/takosumi-kind-aws-fargate-web-service`          | `aws-fargate-web-service`          |
| `@takos/takosumi-kind-gcp-cloud-run-web-service`        | `gcp-cloud-run-web-service`        |
| `@takos/takosumi-kind-kubernetes-web-service`           | `kubernetes-web-service`           |
| `@takos/takosumi-kind-docker-compose-web-service`       | `docker-compose-web-service`       |
| `@takos/takosumi-kind-systemd-web-service`              | `systemd-web-service`              |
| `@takos/takosumi-kind-cloudflare-container-web-service` | `cloudflare-container-web-service` |
| `@takos/takosumi-kind-azure-container-apps-web-service` | `azure-container-apps-web-service` |

## Native data packages

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

## Native gateway packages

| Package                                       | kind alias               |
| --------------------------------------------- | ------------------------ |
| `@takos/takosumi-kind-cloudflare-dns-gateway` | `cloudflare-dns-gateway` |
| `@takos/takosumi-kind-aws-route53-gateway`    | `aws-route53-gateway`    |
| `@takos/takosumi-kind-gcp-cloud-dns-gateway`  | `gcp-cloud-dns-gateway`  |
| `@takos/takosumi-kind-coredns-gateway`        | `coredns-gateway`        |

Gateway package は HTTP reachability を作る native kind です。`gateway` portable kind の route vocabulary は [Kind Catalog](./type-catalog.md#gateway-portable-subset) にあります。native package は DNS / listener / TLS / route support の具体制約を持てます。

## Reference adapter exports

各 native kind package は、その kind URI を `KernelPlugin.provides[]` に入れる factory を export します。factory 名は package の対象に合わせた named export です。例:

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

`plugins` は reference kernel の実装手段です。互換 implementation は同じ kind URI を native controller、static registry、workflow engine、SaaS adapter などに bind できます。

## Package ownership rule

- kind の descriptor source は owning kind package の `spec/kind.jsonld`。
- portable descriptor source は `takosumi/packages/kind-*`、native descriptor source は `takosumi-plugins/packages/kind-*`。
- package の public identity は `@takos/takosumi-kind-<alias>`。
- alias の有効化は operator の `kindAliases` が決めます。
- backend によって `spec` や material output が変わるなら別 native kind package にします。

## Related pages

- [Manifest](./manifest.md)
- [Kind Catalog](./type-catalog.md)
