# Runtime-Agent API

> このページでわかること: runtime-agent process が公開する HTTP RPC v1 仕様。

runtime-agent は operator が cloud / OS credential を握る host で起動し、 kernel
の下流 execution surface として `(kind, provider)` 単位の lifecycle envelope
を受けます。

逆方向の制御 (enroll / heartbeat / lease / drain / gateway-manifest 署名) は
[Kernel HTTP API — Runtime-Agent control RPC](/reference/kernel-http-api#runtime-agent-control-rpc)
参照。

## Authentication

| Credential   | Env var                | 適用範囲                            | 認証方式                        |
| ------------ | ---------------------- | ----------------------------------- | ------------------------------- |
| Agent bearer | `TAKOSUMI_AGENT_TOKEN` | `/v1/lifecycle/*`、`/v1/connectors` | `Authorization: Bearer <token>` |

`TAKOSUMI_AGENT_TOKEN` は kernel と runtime-agent が共有する shared secret。
未設定起動の agent は lifecycle / connectors request 全部に 401。 `/v1/health`
のみ無認証で orchestrator probe (Kubernetes / Nomad / docker healthcheck) を想
定。

artifact bytes 取得が必要な connector には、 kernel が
`LifecycleApplyRequest.artifactStore` に `baseUrl` と
`TAKOSUMI_ARTIFACT_FETCH_TOKEN` を載せて渡します。 agent token とは別物で、
scope は `GET /v1/artifacts/:hash` のみ
([Authentication](/reference/kernel-http-api#authentication))。

## Endpoints

| Method | Path                       | Auth        | Purpose                                                           |
| ------ | -------------------------- | ----------- | ----------------------------------------------------------------- |
| GET    | `/v1/health`               | -           | `{ status: "ok", connectors: <count> }`                           |
| GET    | `/v1/connectors`           | Agent token | 起動時に登録された `(kind, provider, acceptedArtifactKinds)` 一覧 |
| POST   | `/v1/lifecycle/apply`      | Agent token | resource を作成 / 更新                                            |
| POST   | `/v1/lifecycle/destroy`    | Agent token | handle 指定で resource を削除                                     |
| POST   | `/v1/lifecycle/compensate` | Agent token | WAL recovery 用に commit 済み effect を逆再生                     |
| POST   | `/v1/lifecycle/describe`   | Agent token | handle 指定で実体の状態を取得                                     |
| POST   | `/v1/lifecycle/verify`     | Agent token | connector ごとに `verify` operation を smoke test                 |

### `POST /v1/lifecycle/apply`

`LifecycleApplyRequest`:

```ts
interface LifecycleApplyRequest {
  readonly kind: string; // 例: "object-store" (short name) or "https://takosumi.com/kinds/v1/object-store" (URI)
  readonly provider: string; // 例: "aws-s3"
  readonly resourceName: string; // component / internal resource name
  readonly spec: JsonValue; // component kind spec (kernel 側で validate 済み)
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
  readonly outputs: JsonObject; // component kind が宣言した outputs
}
```

`handle` は kernel 側 deployment record に persist され、 以降の `destroy` /
`describe` の key になります。

WAL-backed public apply では kernel が `PlatformContext.operation` から
`idempotencyKey` / `operationRequest` / `metadata.takosumiOperation` を envelope
に転送します。 connector は外部 API が idempotency / client request token を
受け付ける場合、 この `idempotencyKey` をそのまま渡します。

### `POST /v1/lifecycle/destroy`

`LifecycleDestroyRequest`:

```ts
interface LifecycleDestroyRequest {
  readonly kind: string;
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

connector は `destroy` を delete-if-exists な冪等動作として実装します。 実体が
既に消えている場合は HTTP 200 + `ok: true` + `note` で返すのが推奨。

WAL-backed public destroy でも apply と同じ key が転送されます。 削除 API に
external request token が無い provider は、 connector 内部の local ledger / tag
/ annotation で同じ key を使って重複 side effect を抑止します。

### `POST /v1/lifecycle/compensate`

`LifecycleCompensateRequest`:

```ts
interface LifecycleCompensateRequest {
  readonly kind: string;
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

`compensate` は commit 済み effect を逆再生する connector-native operation で
す。 専用 operation が無い connector は handle-keyed `destroy` に fallback。
完全に逆再生できない場合は `revokeDebtRequired: true` を返し、 kernel が
RevokeDebt として保持します。

### `POST /v1/lifecycle/describe`

`LifecycleDescribeRequest`:

```ts
interface LifecycleDescribeRequest {
  readonly kind: string;
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
`docker inspect` / `systemctl is-active` 等) で実体を毎回問い合わせる方式。
kernel apply 時の outputs に依存しないので、 runtime-agent restart 後も同じ結
果を返せる必要があります。

### `POST /v1/lifecycle/verify`

connector の `verify` operation を smoke test します。Request:

```ts
interface LifecycleVerifyRequest {
  readonly targets?: readonly {
    readonly kind: string;
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
  readonly kind: string; // verify 対象の component kind
  readonly provider: string; // verify 対象の provider id
  readonly ok: boolean; // smoke test 結果 (true = 健全)
  readonly code?: string; // ok=false 時に設定される LifecycleErrorCode
  readonly note?: string; // 詳細メッセージ (operator が読む)
  readonly details?: JsonObject; // connector が返す追加情報 (latency, scope 等)
  readonly latencyMs?: number; // smoke test 所要時間
  readonly checkedAt: string; // ISO 8601 timestamp
}
```

`results[]` は順序保証なし。 caller は `(kind, provider)` で集計します。

## Connector retry / credential refresh

`buildConnectorRegistry()` は connector の lifecycle operation を共通の
resilience wrapper で包みます。 retry 対象は次のみ:

- `HTTP 408` / `425` / `429` / `500` / `502` / `503` / `504`
- `TypeError` / `ECONNRESET` / `ETIMEDOUT` などの network failure
- `retryable: true` を持つ connector error

`HTTP 400` 等の provider validation error、 `retryable: false`、 permission
denied 等の恒久 failure は retry せず。 retry は bounded exponential backoff
で同じ envelope を再投入します。 connector は `idempotencyKey` / provider-native
client token / handle-keyed delete で重複 side effect を抑止 します。

credential refresh は opt-in。
`ConnectorBootOptions.resilience.refreshCredentials` を渡した場合のみ、 wrapper
は `HTTP 401` / expired token を検出して refresh を 1 回呼び、 同じ operation
を再試行します。 refresh 未設定なら credential error は通常の connector failure
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

- `apply` 成功は `running` に遷移。 失敗は `connector_failed` を返し kernel 側
  で `error` projection。
- `destroy` 成功は `missing` に遷移。 以降 `describe` も `missing` を返します。
- `describe` は実体 API を毎回叩くので 5 値いずれにも遷移し得ます。 `unknown` は
  rate limit / transient error 等で API が一時応答できない時の予備。
- `verify` は status を materialize しません。 connector credential / network
  reachability の health probe に専念し、 結果は
  `LifecycleVerifyResponse.results[].ok` に集約します。

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

`code` は v1 closed enum。 `connector-extended:` prefix は connector 拡張用の
予約で、 kernel は共通 error logic に載せず connector の string をそのまま actor
に伝えます。

| `code`                   | HTTP   | 発生条件                                                            |
| ------------------------ | ------ | ------------------------------------------------------------------- |
| `unauthorized`           | 401    | bearer 不足 / mismatch                                              |
| `bad_request`            | 400    | request body の shape validation 失敗                               |
| `connector_not_found`    | 404    | `(kind, provider)` に対応する connector が registry にいない        |
| `artifact_kind_mismatch` | 400    | `spec.artifact.kind` が connector の `acceptedArtifactKinds` に無い |
| `connector_failed`       | 500    | connector が throw した想定外エラー                                 |
| `connector-extended:*`   | (任意) | connector 拡張用の予約 prefix                                       |

`retryable: true` は network / rate limit / transient cloud failure を表す
フラグ。 kernel は WAL の `pre-commit` / `commit` stage で再試行可否をこれで
分岐します。

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
- [Provider Plugins — Implementation Contract](/reference/providers#implementation-contract)
- [Closed Enums](/reference/closed-enums)
