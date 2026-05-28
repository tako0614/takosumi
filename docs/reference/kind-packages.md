# Reference Kind Packages {#kind-packages}

Takosumi core は kind-agnostic です。manifest は `kind` だけで component の種類を選び、operator distribution が catalog / alias / implementation binding を供給します。各 kind の descriptor、TypeScript helper、validator は **kind package** に置きます。Backend-specific native kind package は、reference kernel に attach する `KernelPlugin` factory も export できます。これは reference implementation の配線方法で、AppSpec の必須 mechanism ではありません。package は `@takos/takosumi-kind-<alias>` です。

Repository ownership は二つに分かれます。portable kind package は `takosumi/` に残り、backend-specific native kind package は `takosumi-plugins/` に置きます。package 名はどちらも `@takos/takosumi-kind-*` を使います。

`worker` のような portable kind は共通最小契約です。`cloudflare-worker` のような native kind は substrate 固有契約です。backend 固有の field や output shape が必要なら native kind を使います。`provider` field は manifest にはありません。

## Portable kind packages

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

Portable kind は `takosumi/packages/kind-*` の descriptor と helper を提供します。descriptor は portable `spec` vocabulary、output slot、connection compatibility を定義します。alias は URI への短縮名で、解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します。portable alias を portable URI に解決する場合、operator はその portable URI を実装する binding を attach します。native kind URI に解決する alias は native schema を選ぶ alias です。

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

## Native gateway packages

| Package                                       | kind alias               |
| --------------------------------------------- | ------------------------ |
| `@takos/takosumi-kind-cloudflare-dns-gateway` | `cloudflare-dns-gateway` |
| `@takos/takosumi-kind-aws-route53-gateway`    | `aws-route53-gateway`    |
| `@takos/takosumi-kind-gcp-cloud-dns-gateway`  | `gcp-cloud-dns-gateway`  |
| `@takos/takosumi-kind-coredns-gateway`        | `coredns-gateway`        |

Native gateway packages は HTTP reachability を作る implementation binding を提供できます。`gateway` portable kind の route vocabulary は [公式カタログ](./catalog.md#gateway-portable-subset) にあります。`routes[].to` は local `connect` binding key を指します。native package は DNS / listener / TLS / route support の具体制約を持てます。

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

`plugins` は reference kernel の実装手段です。互換 implementation は同じ kind URI を native controller、static registry、workflow engine、SaaS adapter などに bind できます。

## Provider live proof

native kind package のローカル検証は `takosumi-plugins/` の check / test /
publish dry-run で行います。実 provider への materialization proof は operator-owned
infrastructure と credential を使う外部証跡です。Takosumi は proof shape
と credential-free fixture gate を提供します。

```sh
cd takosumi
deno task live-provisioning-smoke:fixture:all
```

この fixture gate は AWS、GCP、Kubernetes、Cloudflare、self-host、external
provider shape を検証します。live proof は operator の provider gateway
に対して同じ fixture を流します。

```sh
cd takosumi
TAKOSUMI_PLUGIN_LIVE_PROOF_MODE=live \
TAKOSUMI_PLUGIN_LIVE_PROVIDER=cloudflare \
TAKOSUMI_PLUGIN_LIVE_PROOF_FIXTURE_FILE=fixtures/live-provisioning/cloudflare.shape-v1.json \
TAKOSUMI_PLUGIN_GATEWAY_URL=https://<operator-provider-gateway> \
TAKOSUMI_PLUGIN_GATEWAY_BEARER_TOKEN=<operator-token> \
deno task live-provisioning-smoke
```

provider ごとの canonical fixture:

| Provider   | Fixture                                               |
| ---------- | ----------------------------------------------------- |
| Cloudflare | `fixtures/live-provisioning/cloudflare.shape-v1.json` |
| self-host  | `fixtures/live-provisioning/selfhosted.shape-v1.json` |
| AWS        | `fixtures/live-provisioning/aws.shape-v1.json`        |
| GCP        | `fixtures/live-provisioning/gcp.shape-v1.json`        |
| Kubernetes | `fixtures/live-provisioning/kubernetes.shape-v1.json` |

`TAKOSUMI_PLUGIN_LIVE_CLEANUP_ONLY=1` を付けると同じ desired state の teardown
だけを実行します。live report は public docs に貼らず、operator の private
evidence store に保存します。

## Package ownership rule

- kind の descriptor source は owning kind package の `spec/kind.jsonld`。JSON-LD は catalog / schema metadata であり、runtime plugin requirement ではない。
- portable descriptor source は `takosumi/packages/kind-*`、native descriptor source は `takosumi-plugins/packages/kind-*`。
- package の public identity は `@takos/takosumi-kind-<alias>`。
- alias の有効化は operator の `kindAliases` が決めます。
- 解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します。
- backend によって `spec` や material output が変わるなら別 native kind package にします。

## Related pages

- [Manifest](./manifest.md)
- [公式カタログ](./catalog.md)
- [Kind Binding 実装](./kind-bindings.md)
- [Reference Adapter Loading](./plugin-loading.md)
