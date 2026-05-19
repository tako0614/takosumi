# Provider Plugins

> このページでわかること: bundled provider plugin の一覧と対応 component kind。

**provider plugin** は AppSpec の
[component kind](/reference/kind-catalog#component-kinds) を具体的な cloud /
local backend 上に materialize する。 各 plugin は実装する kind、サポートする
capability vocabulary、 kernel が OperationPlan 実行中に呼ぶ apply / destroy /
status lifecycle を宣言する。

Takosumi は out of the box で **21 個の provider plugin** を ship する。 20 は
default で配線され、1 個 (`@takos/deno-deploy`) は opt-in。 plugin は paper-thin
な lifecycle client であり、 credential、cloud SDK code、副作用はすべて
**runtime-agent** の背後に住む。 provider identity は `connector:<id>`
として識別する。 operator が agent 上で connector を install / control
するため、ある deployment から到達可能な provider は operator が所有する
(operator-installed / operator-controlled は意図的)。

Source roots:

- `packages/contract/src/provider-plugin.ts` — public `ProviderPlugin` contract
  と `KernelPlugin` interface (= `name` / `version` / `provides[]` (kind URI) /
  `capabilities` / `apply` / `destroy` / install/deployment hook)。
- `packages/plugins/src/kinds/<kind>.ts` — bundled component kind schema /
  outputs。
- `packages/<cloud>-providers/src/<kind>-<provider>.ts` — operator-facing
  `KernelPlugin` factory (`createPaaSApp({ plugins: [...] })` に直接渡せる plain
  function)。 operator は env から credential を読んで factory に渡す。 cloud
  別に 6 package
  (`@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-providers`)
  に分離されており、 operator は使う cloud だけを import する。

## Capability vocabulary: open string + reserved prefix

capability は **open string**。 provider は `capabilities` 配列に任意の
kebab-case 識別子を宣言でき、 AppSpec は任意の識別子を `requires` で参照できる。
selection は subset 所属だけをチェックする: provider が selectable なのは
`requires ⊆ capabilities` の場合に限る。

global vocabulary を一貫させるため、3 prefix が **reserved**。

| Prefix       | Owner                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `takos.*`    | consumer-application reserved namespace (e.g. Takos product surface); kernel assumes no Takos-specific semantics |
| `system.*`   | Takosumi kernel / runtime-agent / observation tier                                                               |
| `operator.*` | Operator-defined deployment-local capabilities                                                                   |

bare identifier (no `.`) は任意 provider が宣言できる **general capability**。
新 reserved prefix の追加は `CONVENTIONS.md` §6 RFC で governed され、 kernel
coordination を要する。 既存 reserved prefix 内では、 `takos.*` / `system.*`
下の識別子追加も §6 RFC を通る。 `operator.*` は自 deployment 内で operator
が自由に定義できる。

## Bundled provider catalog

同梱されている 21 個の provider をクラウド別にグルーピング。 すべて
`@takos/<cloud>-*` 形式の id を持つ。 component kind と capability 集合は
`packages/<cloud>-providers/src/<kind>-<provider>.ts` の各 factory と完全に
一致する。 **extension policy** 列は、サードパーティが標準の provider PR
フローで capability を追加してよいか (extensible)、 あるいは in-tree provider
内で capability 集合が閉じているか (closed-within-provider) を示す。

### AWS

| provider id          | component kind  | declared capabilities                                                                                                                   | extension policy |
| -------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@takos/aws-s3`      | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` | extensible       |
| `@takos/aws-fargate` | `worker`        | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        | extensible       |
| `@takos/aws-rds`     | `postgres`      | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   | extensible       |
| `@takos/aws-route53` | `custom-domain` | `wildcard`, `auto-tls`, `sni`, `alpn-acme`                                                                                              | extensible       |

### GCP

| provider id            | component kind  | declared capabilities                                                                                                                   | extension policy |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@takos/gcp-gcs`       | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` | extensible       |
| `@takos/gcp-cloud-run` | `worker`        | `always-on`, `scale-to-zero`, `websocket`, `long-request`                                                                               | extensible       |
| `@takos/gcp-cloud-sql` | `postgres`      | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   | extensible       |
| `@takos/gcp-cloud-dns` | `custom-domain` | `wildcard`, `auto-tls`, `sni`                                                                                                           | extensible       |

### Cloudflare

| provider id                   | component kind  | declared capabilities                                       | extension policy |
| ----------------------------- | --------------- | ----------------------------------------------------------- | ---------------- |
| `@takos/cloudflare-r2`        | `object-store`  | `presigned-urls`, `public-access`, `multipart-upload`       | extensible       |
| `@takos/cloudflare-container` | `worker`        | `scale-to-zero`, `geo-routing`                              | extensible       |
| `@takos/cloudflare-workers`   | `worker`        | `scale-to-zero`, `websocket`, `long-request`, `geo-routing` | extensible       |
| `@takos/cloudflare-dns`       | `custom-domain` | `wildcard`, `auto-tls`, `sni`, `http3`                      | extensible       |

### Azure

| provider id                   | component kind | declared capabilities                                     | extension policy |
| ----------------------------- | -------------- | --------------------------------------------------------- | ---------------- |
| `@takos/azure-container-apps` | `worker`       | `always-on`, `scale-to-zero`, `websocket`, `long-request` | extensible       |

### Kubernetes

| provider id                    | component kind | declared capabilities                                          | extension policy |
| ------------------------------ | -------------- | -------------------------------------------------------------- | ---------------- |
| `@takos/kubernetes-deployment` | `worker`       | `always-on`, `websocket`, `long-request`, `private-networking` | extensible       |

### Deno Deploy (opt-in)

| provider id          | component kind | declared capabilities                          | extension policy |
| -------------------- | -------------- | ---------------------------------------------- | ---------------- |
| `@takos/deno-deploy` | `worker`       | `scale-to-zero`, `long-request`, `geo-routing` | extensible       |

### Selfhost

| provider id                      | component kind  | declared capabilities                                                                                            | extension policy       |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@takos/selfhost-filesystem`     | `object-store`  | `presigned-urls`                                                                                                 | closed-within-provider |
| `@takos/selfhost-minio`          | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` | extensible             |
| `@takos/selfhost-docker-compose` | `worker`        | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       | extensible             |
| `@takos/selfhost-systemd`        | `worker`        | `always-on`, `long-request`                                                                                      | closed-within-provider |
| `@takos/selfhost-postgres`       | `postgres`      | `ssl-required`, `extensions`                                                                                     | closed-within-provider |
| `@takos/selfhost-coredns`        | `custom-domain` | `wildcard`                                                                                                       | closed-within-provider |

## Selection rule

AppSpec component ごとに、kernel は provider hint が一致 (set されているとき)
し、かつ `capabilities` が `requires` の superset である plugin を選ぶ。
宣言集合が `requires` を満たさない provider を指名する request は、 apply
lifecycle が走る前の validation 時点で reject される。

## Deno Deploy opt-in flow

`@takos/deno-deploy` は default factory output から除外されている。 online 化は
2 ステップ。

1. **runtime-agent に connector を register**。 agent host で
   `TAKOSUMI_AGENT_DENO_DEPLOY_TOKEN` (および optional
   `TAKOSUMI_AGENT_DENO_DEPLOY_ORG`、`TAKOSUMI_AGENT_DENO_DEPLOY_PROJECT`) を
   set して、 agent の `ConnectorBootOptions` が起動時に Deno Deploy connector
   を resolve するようにする。 credential は agent だけが保持し、kernel は token
   を見ない。
2. **kernel 側で plugin を attach**。 operator は
   `createPaaSApp({ plugins: [denoDeployWorkerProvider({ token, organizationId }), ...] })`
   で `denoDeployWorkerProvider` factory を plain array に追加する。 plugin は
   `worker` kind に対して register され、AppSpec から selectable になる。

検証は `worker` component の provider hint を `@takos/deno-deploy` にして apply
を発行する。 kernel は apply lifecycle envelope を記録し、 agent は inject
された token を使って Deno Deploy API に forward し、 返ってきた `WorkerOutputs`
(`url`、`scriptName`、optional `version`) が apply result を通って戻る。

## Public API surface

operator-facing entry は **`createPaaSApp({ plugins })`** の plain array (= Vite
plugin pattern)。 各 plugin は `KernelPlugin` を返す factory function で、
provider lifecycle と install / deployment hook を 1 つの interface で表現する。

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";

const { app } = await createPaaSApp({
  plugins: [
    cloudflareWorkerProvider({ accountId, apiToken }),
    awsS3ObjectStoreProvider({ region, accessKeyId, secretAccessKey }),
  ],
});
```

`KernelPlugin` interface (= `packages/contract/src/plugin.ts`):

```ts
interface KernelPlugin {
  readonly name: string; // e.g. "@takos/cloudflare-workers"
  readonly version: string; // semver
  readonly provides: readonly string[]; // canonical kind URI(s)
  readonly capabilities: readonly string[];
  apply(spec, ctx): Promise<ApplyResult>;
  destroy(handle, ctx): Promise<void>;
  onInstallStart?(ctx): Promise<void>;
  onInstallComplete?(ctx): Promise<void>;
  onDeploymentStart?(ctx): Promise<void>;
  onDeploymentComplete?(ctx): Promise<void>;
}
```

bundled `kernelPluginFromProviderPlugin()` adapter は既存 `ProviderPlugin`
factory を `KernelPlugin` に lift する helper。 `PlatformContext` は
tenant-scoped secret store、 KMS port、 object storage port、 observability
sink、 publish / listen で resolve された material map を運ぶ。 plain array
attach は plugin marketplace / signed manifest fetch / port-based plugin host
を必要としない。

## Cross-references

- [Access Modes](/reference/access-modes) — provider 管理 object が consumer
  に自身を expose する仕方を支配する closed v1 access mode enum (`read` /
  `read-write` / `admin` / `invoke-only` / `observe-only`)。
- [Artifact Kinds](/reference/kind-catalog#artifact-kinds) — bundled DataAsset
  kinds (`oci-image` / `js-bundle` / `lambda-zip` / `static-bundle` / `wasm`) と
  provider が apply 時に受け取る registry。
- [Connector Contract](/reference/connector-contract) — operator-installed
  connector identity (`connector:<id>`)、accepted-kind vector、Space
  visibility、signing expectations、provider が consume する envelope
  versioning。
- [Closed Enums](/reference/closed-enums) — object lifecycle class と provider
  が output 発行時に尊重すべき closed enum。
- `CONVENTIONS.md` §6 RFC (takosumi repo root) — 新 reserved capability prefix
  の提案プロセス、 component-kind capability union への変更プロセス。

## 関連ページ

- [Kind Catalog](/reference/kind-catalog#component-kinds)
- [Connector Contract](/reference/connector-contract)
- [Access Modes](/reference/access-modes)
