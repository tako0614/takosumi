# Runtime-Agent API

> このページでわかること: runtime-agent API の仕様と gateway-manifest の構造。

Takosumi runtime-agent process が公開する HTTP RPC の v1 reference です。
runtime-agent は **operator が cloud / OS credential を保持するホストで起動 する
process** で、kernel から見ると下流の execution surface に当たります。 kernel は
credential を持たず、(`shape`, `provider`) 単位の lifecycle envelope を本 API へ
POST し、connector が backing する cloud SDK / OS API の呼び出しを delegate
します。

逆方向の制御 (kernel → runtime-agent への enroll / heartbeat / lease / drain /
gateway-manifest 署名) は kernel 側 internal control plane に実装され、
[Kernel HTTP API — Runtime-Agent control RPC](/reference/kernel-http-api#runtime-agent-control-rpc)
側で扱います。本ページは **runtime-agent process が公開する HTTP endpoint**
に絞った仕様です。

## Authentication

| Credential   | Env var                | 適用範囲                            | 認証方式                        |
| ------------ | ---------------------- | ----------------------------------- | ------------------------------- |
| Agent bearer | `TAKOSUMI_AGENT_TOKEN` | `/v1/lifecycle/*`、`/v1/connectors` | `Authorization: Bearer <token>` |

`TAKOSUMI_AGENT_TOKEN` は kernel と runtime-agent の間で共有する shared secret
です。token を未設定で起動した runtime-agent は **すべての lifecycle /
connectors request に 401** を返します。`/v1/health` のみ無認証で、 orchestrator
(Kubernetes / Nomad / docker healthcheck) からの probe を想定 します。

connector が artifact bytes を取得する必要がある場合、kernel は
`LifecycleApplyRequest.artifactStore` に `baseUrl` と
`TAKOSUMI_ARTIFACT_FETCH_TOKEN` を載せて渡します。これは agent token
と完全に別物で、scope は `GET /v1/artifacts/:hash` のみに限定されます
([Kernel HTTP API — Authentication](/reference/kernel-http-api#authentication))。

## Endpoints

| Method | Path                       | Auth        | Purpose                                                            |
| ------ | -------------------------- | ----------- | ------------------------------------------------------------------ |
| GET    | `/v1/health`               | -           | `{ status: "ok", connectors: <count> }`                            |
| GET    | `/v1/connectors`           | Agent token | 起動時に登録された `(shape, provider, acceptedArtifactKinds)` 一覧 |
| POST   | `/v1/lifecycle/apply`      | Agent token | resource を作成 / 更新                                             |
| POST   | `/v1/lifecycle/destroy`    | Agent token | handle 指定で resource を削除                                      |
| POST   | `/v1/lifecycle/compensate` | Agent token | WAL recovery 用に commit 済み effect を逆再生                      |
| POST   | `/v1/lifecycle/describe`   | Agent token | handle 指定で実体の状態を取得                                      |
| POST   | `/v1/lifecycle/verify`     | Agent token | connector ごとに `verify` operation を smoke test                  |

### `POST /v1/lifecycle/apply`

`LifecycleApplyRequest`:

```ts
interface LifecycleApplyRequest {
  readonly shape: string; // 例: "object-store@v1"
  readonly provider: string; // 例: "aws-s3"
  readonly resourceName: string; // ManifestResource.name と同じ
  readonly spec: JsonValue; // shape spec (kernel 側で validate 済み)
  readonly tenantId?: string;
  readonly idempotencyKey?: string; // WAL 由来の外部 API request token
  readonly operationRequest?: PlatformOperationRequest;
  readonly metadata?: JsonObject; // request id, audit trail 等
  readonly artifactStore?: {
    readonly baseUrl: string; // 例: "https://kernel.example.com"
    readonly token: string; // TAKOSUMI_ARTIFACT_FETCH_TOKEN
  };
}
```

`LifecycleApplyResponse`:

```ts
interface LifecycleApplyResponse {
  readonly handle: string; // 例: "arn:aws:s3:::blog-assets"
  readonly outputs: JsonObject; // shape が宣言した outputs
}
```

`handle` は kernel 側 deployment record に persist され、以降の `destroy` /
`describe` のキー材料になります。

WAL-backed public apply では kernel は `PlatformContext.operation` から
`idempotencyKey`、`operationRequest`、`metadata.takosumiOperation` を
runtime-agent envelope に転送します。connector は外部 API が idempotency token /
client request token を受け付ける場合、この `idempotencyKey`
をそのまま渡します。

### `POST /v1/lifecycle/destroy`

`LifecycleDestroyRequest`:

```ts
interface LifecycleDestroyRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
  readonly idempotencyKey?: string; // WAL 由来の外部 API request token
  readonly operationRequest?: PlatformOperationRequest;
  readonly metadata?: JsonObject;
}
```

`LifecycleDestroyResponse`:

```ts
interface LifecycleDestroyResponse {
  readonly ok: boolean;
  readonly note?: string; // soft-failure や "already gone" の理由
}
```

connector は `destroy` を **delete-if-exists** な冪等動作として実装します。
handle 不在で失敗した場合でも HTTP 200 + `ok: true` + `note` で返すのが推奨 です
(実体側がすでに消えている場合)。

WAL-backed public destroy でも apply と同じく `idempotencyKey`、
`operationRequest`、`metadata.takosumiOperation` が転送されます。削除 API に
external request token が無い provider でも、connector 内部の local ledger / tag
/ annotation で同じ key を使って重複 side effect を抑止します。

### `POST /v1/lifecycle/compensate`

`LifecycleCompensateRequest`:

```ts
interface LifecycleCompensateRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
  readonly idempotencyKey?: string;
  readonly operationRequest?: PlatformOperationRequest;
  readonly metadata?: JsonObject;
  readonly effect?: JsonObject; // WAL に記録された effect detail がある場合
}
```

`LifecycleCompensateResponse`:

```ts
interface LifecycleCompensateResponse {
  readonly ok: boolean;
  readonly note?: string;
  readonly revokeDebtRequired?: boolean;
  readonly detail?: JsonObject;
}
```

`compensate` は recovery / rollback が commit 済み effect を逆再生するための
connector-native operation です。connector が専用 operation
を持たない場合、runtime-agent dispatcher は handle-keyed `destroy` を complete
reverse operation として fallback します。完全に逆再生できない connector は
`revokeDebtRequired: true` を返し、kernel は該当 effect を RevokeDebt
として保持します。

### `POST /v1/lifecycle/describe`

`LifecycleDescribeRequest`:

```ts
interface LifecycleDescribeRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
}
```

`LifecycleDescribeResponse`:

```ts
interface LifecycleDescribeResponse {
  readonly status: LifecycleStatus;
  readonly outputs?: JsonObject;
  readonly note?: string;
}
```

`describe` は connector の read-only API (`HeadBucket` / `DescribeService` /
`docker inspect` / `systemctl is-active` 等) で実体を毎回問い合わせる方式で
実装されます。kernel apply 時の outputs に依存しないので、runtime-agent を
restart しても同じ結果を返せる必要があります。

### `POST /v1/lifecycle/verify`

connector の `verify` operation を smoke test します。Request:

```ts
interface LifecycleVerifyRequest {
  readonly targets?: readonly {
    readonly shape: string;
    readonly provider: string;
  }[];
  readonly options?: JsonObject; // connector ごとに解釈
}
```

`targets` を省略した場合は登録済 connector 全てを対象にします。Response:

```ts
interface LifecycleVerifyResponse {
  readonly results: readonly LifecycleVerifyResult[];
}

interface LifecycleVerifyResult {
  readonly shape: string; // verify 対象の shape
  readonly provider: string; // verify 対象の provider id
  readonly ok: boolean; // smoke test 結果 (true = 健全)
  readonly code?: string; // ok=false 時に設定される LifecycleErrorCode
  readonly note?: string; // 詳細メッセージ (operator が読む)
  readonly details?: JsonObject; // connector が返す追加情報 (latency, scope 等)
  readonly latencyMs?: number; // smoke test 所要時間
  readonly checkedAt: string; // ISO 8601 timestamp
}
```

`results[]` は順序保証されません。caller は `(shape, provider)` を key として
集計してください。

## Connector retry / credential refresh

runtime-agent の `buildConnectorRegistry()` は、登録する connector の lifecycle
operation (`apply` / `destroy` / `compensate` / `describe` / `verify`) を共通の
resilience wrapper で包みます。既定では以下だけを retry 対象にします。

- `HTTP 408` / `425` / `429` / `500` / `502` / `503` / `504`
- `TypeError` や `ECONNRESET` / `ETIMEDOUT` などの network failure
- `retryable: true` を持つ connector error

`HTTP 400` などの provider validation error、`retryable: false` を持つ error、
permission denied などの恒久 failure は retry しません。retry は bounded
exponential backoff で、同じ lifecycle envelope を再投入します。connector は
`idempotencyKey` / provider-native client token / handle-keyed delete を使い、
再投入で duplicate side effect が増えないように実装します。

credential refresh は opt-in です。operator が
`ConnectorBootOptions.resilience.refreshCredentials` を渡した場合のみ、wrapper
は `HTTP 401` や expired token / credential に見える error を検出して refresh
operation を 1 回呼び、その後同じ lifecycle operation を再試行します。refresh
operation が無い場合、 credential error は通常の connector failure
として返ります。

## Lifecycle status state machine

`LifecycleStatus` は v1 で 5 値の closed enum です。

```ts
type LifecycleStatus =
  | "running"
  | "stopped"
  | "missing"
  | "error"
  | "unknown";
```

各 RPC が観測 / 遷移させ得る状態は以下の通りです。

```
apply ─────────────► running
                     │
              describe (live)
                     │
     ┌───────────────┼────────────────┐
     ▼               ▼                ▼
  running         stopped           error
     │               │                │
     │               │                │
  destroy         destroy           verify
     │               │                │
     ▼               ▼                ▼
  missing         missing          running / error
                     │                │
                 describe          (verify は status を直接書き換えず、
                     │           報告のみで `running` / `error` の
                     ▼           materialization は describe に委ねる)
                   unknown
```

- `apply` 成功は `running` に遷移させます。失敗時は `connector_failed` を
  返し、kernel 側で `error` として projection されます。
- `destroy` 成功は `missing` に遷移させ、`describe` でも `missing` を返す
  状態になります。
- `describe` は実体 API
  を毎回叩くので、`running / stopped / missing /
  error / unknown`
  のいずれにも遷移し得ます。`unknown` は API が一時的に 応答できない (rate limit
  / transient error) 場合に予備として返します。
- `verify` は status を materialize しません。connector の credential や network
  reachability の health probe に専念し、結果は
  `LifecycleVerifyResponse.results[].ok` に集約されます。

## Error envelope

すべての failure は `LifecycleErrorBody` を 4xx / 5xx で返します。

```ts
interface LifecycleErrorBody {
  readonly error: string; // 人間向け message
  readonly code: LifecycleErrorCode; // closed enum + connector-extended:* 予約
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}
```

`code` は v1 で以下の closed enum です。`connector-extended:` prefix は
connector 拡張のために予約されており、kernel 側で透過的にハンドリングされ ます
(kernel は prefix を見て、共通エラーロジックには載せず、connector が 返した
string をそのまま actor に伝えます)。

| `code`                   | HTTP   | 発生条件                                                            |
| ------------------------ | ------ | ------------------------------------------------------------------- |
| `unauthorized`           | 401    | bearer 不足 / mismatch                                              |
| `bad_request`            | 400    | request body の shape validation 失敗                               |
| `connector_not_found`    | 404    | `(shape, provider)` に対応する connector が registry にいない       |
| `artifact_kind_mismatch` | 400    | `spec.artifact.kind` が connector の `acceptedArtifactKinds` に無い |
| `connector_failed`       | 500    | connector が throw した想定外エラー                                 |
| `connector-extended:*`   | (任意) | connector 拡張用の予約 prefix                                       |

`retryable: true` は kernel apply pipeline が rollback / re-attempt の判断
に使うフラグで、network / rate limit / transient cloud failure 等を表します。
kernel は WAL の `pre-commit` / `commit` stage における再試行可否を本値で
分岐させます。

## Cross-references

- [Lifecycle Phases](/reference/lifecycle-phases) — phase ごとの input / output
  snapshot 対応と `LifecycleStatus` 5 値の trigger 別 遷移。runtime-agent
  describe が報告する条件はここに集約されている。
- [Lifecycle Protocol](/reference/lifecycle) — cross-process lock と recovery
  mode 選択を含む運用面。
- [Closed Enums](/reference/closed-enums) — `LifecycleErrorBody` codes /
  `LifecycleStatus` / DataAsset kinds 等の closed enum hub。
- [Connector Contract](/reference/connector-contract) — `connector:<id>`
  identity, accepted-kind vector, Space visibility, signing expectations,
  envelope versioning that the runtime-agent hosts.
- [Kernel HTTP API](/reference/kernel-http-api)

## 関連ページ

- [Lifecycle Phases](/reference/lifecycle-phases)
- [Provider Implementation Contract](/reference/provider-implementation-contract)
- [Closed Enums](/reference/closed-enums)
