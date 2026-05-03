# Runtime-Agent HTTP API

Takosumi runtime-agent (`@takos/takosumi-plugins` + `@takos/takosumi-kernel` の
runtime-agent server) が公開する HTTP endpoint の reference です。実装は
[`packages/runtime-agent/src/server.ts`](https://github.com/tako0614/takosumi/blob/master/packages/runtime-agent/src/server.ts)、
request / response 型は
[`packages/contract/src/runtime-agent-lifecycle.ts`](https://github.com/tako0614/takosumi/blob/master/packages/contract/src/runtime-agent-lifecycle.ts)。

runtime-agent は **kernel から見て下流のサービス**で、operator が
cloud credential (`AWS_ACCESS_KEY_ID` / `CLOUDFLARE_API_TOKEN` 等) や OS
access (docker daemon / systemd) を保持するホストで起動します。kernel は
crendential を持たず、`(shape, provider)` lifecycle envelope を本 API へ
HTTP POST するだけ — credential boundary は agent host で閉じる、という
分担です。kernel boot の env / token 配置は
[Operator: Bootstrap](/operator/bootstrap) を、kernel 側 API は
[Kernel HTTP API](/reference/kernel-http-api) を参照してください。

## Auth

| Credential | Env var                | 適用範囲                              | 認証方式                       |
| ---------- | ---------------------- | ------------------------------------- | ------------------------------ |
| Agent token | `TAKOSUMI_AGENT_TOKEN` | `/v1/lifecycle/*`、`/v1/connectors`   | `Authorization: Bearer <token>` |

- token は **kernel と runtime-agent の間で共有する shared secret**で、
  contract export
  [`LIFECYCLE_AGENT_TOKEN_ENV`](https://github.com/tako0614/takosumi/blob/master/packages/contract/src/runtime-agent-lifecycle.ts)
  に env 名が固定されています。
- token を未設定で `serveRuntimeAgent(...)` を起動すると **すべての
  lifecycle / connectors request が 401** を返します (`expectedAuth =
  "Bearer " + options.token`)。
- `/v1/health` のみ無認証 — orchestrator (Kubernetes / Nomad / docker
  healthcheck) からの probe を想定。
- token rotation は process restart で行います。runtime-agent server 自身は
  token を再読込しません。
- kernel は同じ token を `LifecycleApplyRequest.artifactStore.token` に乗せて
  渡しますが、こちらは **artifact 取得用の read-only token** であり、
  agent token とは別物です。実装では現状同じ kernel token を渡しても良い設計
  ですが、本番では
  [`TAKOSUMI_ARTIFACT_FETCH_TOKEN`](/reference/kernel-http-api#auth-model) に
  分離して compromise 半径を下げてください。

## Endpoints

| Method | Path                       | Auth        | Purpose                                              |
| ------ | -------------------------- | ----------- | ---------------------------------------------------- |
| GET    | `/v1/health`               | -           | `{ status: "ok", connectors: <count> }` を返す         |
| GET    | `/v1/connectors`           | Agent token | 起動時に登録された `(shape, provider, acceptedArtifactKinds)` 一覧 |
| POST   | `/v1/lifecycle/apply`      | Agent token | resource を作成 / 更新                               |
| POST   | `/v1/lifecycle/destroy`    | Agent token | handle 指定で resource を削除                        |
| POST   | `/v1/lifecycle/describe`   | Agent token | handle 指定で実体の状態を取得                        |
| POST   | `/v1/lifecycle/verify`     | Agent token | 各 connector の `verify` hook を smoke test する     |

### `POST /v1/lifecycle/apply`

resource を作成または更新します。kernel apply pipeline (`applyV2`) が
[ManifestResource](/manifest) を `(shape, provider)` 単位に展開し、その
それぞれを本 endpoint に POST します。

request body (`LifecycleApplyRequest`):

```ts
interface LifecycleApplyRequest {
  readonly shape: string;          // 例: "object-store@v1"
  readonly provider: string;       // 例: "aws-s3"
  readonly resourceName: string;   // ManifestResource.name
  readonly spec: JsonValue;        // shape spec (zod 等の validate 済み)
  readonly tenantId?: string;
  readonly metadata?: JsonObject;  // audit trail / request id
  readonly artifactStore?: {       // spec が artifact.hash を持つ場合に必要
    readonly baseUrl: string;      // 例: "https://kernel.example.com"
    readonly token: string;        // 通常 TAKOSUMI_ARTIFACT_FETCH_TOKEN
  };
}
```

response (`LifecycleApplyResponse`):

```ts
interface LifecycleApplyResponse {
  readonly handle: string;        // 例: "arn:aws:s3:::blog-assets"
  readonly outputs: JsonObject;   // shape が宣言した outputs
}
```

呼び出し例 (kernel 視点):

```bash
curl -sS https://agent.example.internal/v1/lifecycle/apply \
  -H "Authorization: Bearer $TAKOSUMI_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "shape": "object-store@v1",
    "provider": "aws-s3",
    "resourceName": "blog-assets",
    "spec": { "bucket": "blog-assets", "region": "ap-northeast-1" }
  }'
```

```json
{
  "handle": "arn:aws:s3:::blog-assets",
  "outputs": { "bucketName": "blog-assets", "region": "ap-northeast-1" }
}
```

### `POST /v1/lifecycle/destroy`

`apply` が返した `handle` を渡して resource を削除します。

request (`LifecycleDestroyRequest`):

```ts
interface LifecycleDestroyRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
  readonly metadata?: JsonObject;
}
```

response (`LifecycleDestroyResponse`):

```ts
interface LifecycleDestroyResponse {
  readonly ok: boolean;
  readonly note?: string;        // soft-failure や "already gone" の理由
}
```

connector が partial failure を許容するかは provider 個別仕様。kernel 側は
`ok=false` を error にせず、note を `outputs.note` 等にホップさせる実装が
多いので、`status: 200` でも note を必ず読むのが安全です。

### `POST /v1/lifecycle/describe`

handle 指定で現在の状態を取得。kernel の status projector が
`provider observation` として吸い上げます。

request (`LifecycleDescribeRequest`):

```ts
interface LifecycleDescribeRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
}
```

response (`LifecycleDescribeResponse`):

```ts
interface LifecycleDescribeResponse {
  readonly status: "running" | "stopped" | "missing" | "error" | "unknown";
  readonly outputs?: JsonObject;
  readonly note?: string;
}
```

`status: "missing"` は handle に対応する実体が消えていることを示し、kernel
は `GroupHead` 算出時に "drift" として扱います ([Lifecycle
Protocol](/reference/lifecycle))。

### `GET /v1/health`

orchestrator (Kubernetes liveness / Nomad health) から polling される
無認証 probe。registered connector 数を返すので、`connectors=0` であれば
operator が credentials を inject していない可能性が高いです。

```bash
curl -sS http://127.0.0.1:8789/v1/health
# {"status":"ok","connectors":12}
```

### `GET /v1/connectors`

起動時に `buildConnectorRegistry` (factory) が wire した
`(shape, provider, acceptedArtifactKinds)` 一覧を返します。operator は
**apply の前にこれを叩いて env 設定が想定 connector 集合を作ったか**を
確認するのが推奨フロー — `apply` で `connector_not_found` を踏む前に
切り分けられます。

```bash
curl -sS http://127.0.0.1:8789/v1/connectors \
  -H "Authorization: Bearer $TAKOSUMI_AGENT_TOKEN"
```

```json
{
  "connectors": [
    { "shape": "object-store@v1", "provider": "aws-s3", "acceptedArtifactKinds": [] },
    { "shape": "container@v1", "provider": "aws-fargate", "acceptedArtifactKinds": ["oci-image"] },
    { "shape": "object-store@v1", "provider": "filesystem", "acceptedArtifactKinds": [] }
  ]
}
```

### `POST /v1/lifecycle/verify` (補助)

各 connector の `verify` hook (`Connector.verify(ctx)`) を呼んで cred /
network を smoke test します。body は省略可で、`{ shape?, provider? }` で
filter できます。

```bash
curl -sS http://127.0.0.1:8789/v1/lifecycle/verify \
  -H "Authorization: Bearer $TAKOSUMI_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{
  "results": [
    { "shape": "object-store@v1", "provider": "aws-s3", "ok": true, "note": "credentials valid" },
    { "shape": "container@v1", "provider": "aws-fargate", "ok": false, "code": "permission_denied", "note": "ListClusters denied" }
  ]
}
```

## Error envelope

すべての failure は contract の `LifecycleErrorBody` を 4xx / 5xx で返します:

```ts
interface LifecycleErrorBody {
  readonly error: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}
```

主な `code`:

| `code`                   | HTTP | 発生条件                                                                   |
| ------------------------ | ---- | -------------------------------------------------------------------------- |
| `unauthorized`           | 401  | bearer 不足 / mismatch                                                     |
| `bad_request`            | 400  | `LifecycleApplyRequest` などの shape validation 失敗                       |
| `connector_not_found`    | 404  | `(shape, provider)` に対応する connector が registry にいない              |
| `artifact_kind_mismatch` | 400  | `spec.artifact.kind` が connector の `acceptedArtifactKinds` に無い        |
| `connector_failed`       | 500  | connector が throw した想定外エラー                                         |

## Lifecycle protocol

kernel は 1 つの `ManifestResource` に対し、概ね **`apply` → 必要に応じて
`describe` → tear-down 時に `destroy`** という順序で本 API を叩きます。

- **`apply`**: kernel `applyV2` が prior record を fingerprint match した
  場合は **agent 呼び出しをスキップ** する短絡があり、resource spec が
  変わったときだけ `apply` が POST されます。返却された `handle` は
  kernel の deployment record に persist され、以後の `destroy` /
  `describe` のキー材料になります。
- **`describe`**: kernel の status projector / public API
  (`GET /api/public/v1/deployments/:id/observations`) が呼ぶ read-side。
  agent は connector の read-only API (`HeadBucket` / `DescribeService` 等)
  を叩いて status を返します。
- **`destroy`**: tear-down フェーズ (`takosumi deploy --mode destroy` /
  rollback / GC) で kernel が persisted handle を渡してきます。selfhost
  系 connector は handle = `resource.name` で動きますが、cloud 系は
  ARN / object id を返すため、destroy で record が無いと cloud handle が
  失われます — kernel `POST /v1/deployments` が `destroy` を 409 に
  落とすのはこのためです ([Kernel HTTP API](/reference/kernel-http-api))。

詳細フロー (apply DAG / capability selection / outputs ref resolver) は
[Lifecycle Protocol](/reference/lifecycle) を参照してください。

## Connector resolution

runtime-agent server は起動時に `buildConnectorRegistry(opts)` で
**operator が指定した credential set に応じた `Connector` 集合**を
in-memory `ConnectorRegistry` に登録します
([`packages/runtime-agent/src/connectors/factory.ts`](https://github.com/tako0614/takosumi/blob/master/packages/runtime-agent/src/connectors/factory.ts))。

- registry key は `${shape}::${provider}` で 1:1。複数 instance を持ちたい
  場合は agent process を分けて起動するのが推奨。
- `LifecycleDispatcher.apply / destroy / describe` は `registry.get(shape,
  provider)` で connector を引き、無ければ `ConnectorNotFoundError`
  (`code: connector_not_found`) を返します。
- `apply` のみ追加で `Connector.acceptedArtifactKinds` チェックが走ります
  — `spec.artifact.kind` (legacy `spec.image` は `oci-image` 扱い) が list に
  含まれない場合 `ArtifactKindMismatchError` で 400。connector が
  artifact を消費しない (managed service / DNS / 純粋な bucket) 場合は
  `acceptedArtifactKinds: []` を宣言してください。
- 同梱される selfhost connector (`filesystem` / `docker-compose` /
  `systemd-unit` / `coredns-local` / `minio` / `local-docker-postgres`) は
  常に登録されます。cloud 系 (AWS / GCP / Cloudflare / Azure / k3s /
  Deno Deploy) は `opts.aws` / `opts.gcp` / `opts.cloudflare` / `opts.azure`
  / `opts.kubernetes` / `opts.denoDeploy` のいずれかを供給したときだけ
  registry に入ります。詳細は [Provider Plugins](/reference/providers)。

## 参考リンク

- [Kernel HTTP API](/reference/kernel-http-api) — kernel 側の deploy /
  artifact endpoint
- [Lifecycle Protocol](/reference/lifecycle) — apply DAG / outputs /
  capability selection
- [Provider Plugins](/reference/providers) — 各 connector が backing する
  provider 一覧
- [Operator: Bootstrap](/operator/bootstrap) — env / secret 配置と agent
  process の起動
- [Manifest (Shape Model)](/manifest) — `spec` に何を書けるか
