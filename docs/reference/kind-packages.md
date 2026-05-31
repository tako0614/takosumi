# Reference Kind Packages {#kind-packages}

Takosumi core は kind-agnostic です。manifest は `kind` だけで component の種類を選び、operator distribution が catalog / alias / implementation binding を供給します。各 kind の descriptor、TypeScript helper、validator は **kind package** に置きます。Backend-specific native kind package は、reference kernel に attach する `KernelPlugin` factory も export できます。これは reference implementation の配線方法で、AppSpec の必須 mechanism ではありません。kind は published npm package の subpath として配布します。

kind descriptor は spec であり、すべて単一の公式カタログ `takosumi/docs/kinds/v1/<name>.jsonld` に置きます(base kind も、`portableBase` で base を継承する descriptor も区別なく)。`takosumi-plugins/packages/kind-*` は実装(`KernelPlugin` factory と生成 view)だけを持ち、descriptor source は持ちません。published export 上は backend-specific kind の実装が `@takosjp/takosumi-plugins/kind/<alias>` subpath で配られます。

`worker` のような portable kind は共通最小契約です。`cloudflare-worker` のような native kind は substrate 固有契約です。backend 固有の field や output shape が必要なら native kind を使います。`provider` field は manifest にはありません。

## Portable kind packages

| Subpath export                         | kind alias      |
| -------------------------------------- | --------------- |
| `@takosjp/takosumi/kind/worker`        | `worker`        |
| `@takosjp/takosumi/kind/web-service`   | `web-service`   |
| `@takosjp/takosumi/kind/postgres`      | `postgres`      |
| `@takosjp/takosumi/kind/sqlite`        | `sqlite`        |
| `@takosjp/takosumi/kind/object-store`  | `object-store`  |
| `@takosjp/takosumi/kind/kv-store`      | `kv-store`      |
| `@takosjp/takosumi/kind/message-queue` | `message-queue` |
| `@takosjp/takosumi/kind/vector-store`  | `vector-store`  |
| `@takosjp/takosumi/kind/gateway`       | `gateway`       |

Base kind の descriptor は単一カタログ `takosumi/docs/kinds/v1/` に置かれ、portable `spec` vocabulary、output slot、connection compatibility を定義します。alias は URI への短縮名で、解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します。portable alias を portable URI に解決する場合、operator はその portable URI を実装する binding を attach します。native kind URI に解決する alias は native schema を選ぶ alias です。

## Native worker packages

Native package の source は `takosumi-plugins/packages/kind-*` です。

| Subpath export                                      | kind alias           |
| --------------------------------------------------- | -------------------- |
| `@takosjp/takosumi-plugins/kind/cloudflare-worker`  | `cloudflare-worker`  |
| `@takosjp/takosumi-plugins/kind/deno-deploy-worker` | `deno-deploy-worker` |

## Native web-service packages

| Subpath export                                                    | kind alias                         |
| ----------------------------------------------------------------- | ---------------------------------- |
| `@takosjp/takosumi-plugins/kind/aws-fargate-web-service`          | `aws-fargate-web-service`          |
| `@takosjp/takosumi-plugins/kind/gcp-cloud-run-web-service`        | `gcp-cloud-run-web-service`        |
| `@takosjp/takosumi-plugins/kind/kubernetes-web-service`           | `kubernetes-web-service`           |
| `@takosjp/takosumi-plugins/kind/docker-compose-web-service`       | `docker-compose-web-service`       |
| `@takosjp/takosumi-plugins/kind/systemd-web-service`              | `systemd-web-service`              |
| `@takosjp/takosumi-plugins/kind/cloudflare-container-web-service` | `cloudflare-container-web-service` |
| `@takosjp/takosumi-plugins/kind/azure-container-apps-web-service` | `azure-container-apps-web-service` |

## Native data packages

| Subpath export                                                     | kind alias                          | family          |
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

## Native gateway packages

| Subpath export                                          | kind alias               |
| ------------------------------------------------------- | ------------------------ |
| `@takosjp/takosumi-plugins/kind/cloudflare-dns-gateway` | `cloudflare-dns-gateway` |
| `@takosjp/takosumi-plugins/kind/aws-route53-gateway`    | `aws-route53-gateway`    |
| `@takosjp/takosumi-plugins/kind/gcp-cloud-dns-gateway`  | `gcp-cloud-dns-gateway`  |
| `@takosjp/takosumi-plugins/kind/coredns-gateway`        | `coredns-gateway`        |

Native gateway packages は HTTP reachability を作る implementation binding を提供できます。`gateway` portable kind の route vocabulary は [公式カタログ](./catalog.md#gateway-portable-subset) にあります。`routes[].to` は local `connect` binding key を指します。native package は DNS / listener / TLS / route support の具体制約を持てます。

## Reference adapter exports

各 native kind package は、その kind URI を `KernelPlugin.provides[]` に入れる factory を export します。factory 名は package の対象に合わせた named export です。例:

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
- 全 kind descriptor source は単一カタログ `takosumi/docs/kinds/v1/`。`takosumi-plugins/packages/kind-*` は実装のみ(descriptor source なし)。
- kind の public identity は subpath export。portable kind は `@takosjp/takosumi/kind/<alias>`、native kind は `@takosjp/takosumi-plugins/kind/<alias>`。
- alias の有効化は operator の `kindAliases` が決めます。
- 解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します。
- backend によって `spec` や material output が変わるなら別 native kind package にします。

## Related pages

- [Manifest](./manifest.md)
- [公式カタログ](./catalog.md)
- [Kind Binding 実装](./kind-bindings.md)
- [Reference Adapter Loading](./plugin-loading.md)
