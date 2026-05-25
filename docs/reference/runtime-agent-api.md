# Reference Runtime-Agent Execution Surface {#runtime-agent-api}

runtime-agent は reference Takosumi topology で使う execution host です。
operator が cloud / OS credential を握る host で起動し、kernel の下流 execution
surface として connector-local selector 単位の lifecycle envelope を受けます。

このページは reference runtime-agent topology の HTTP surface を記述します。
Takosumi public conformance surface は AppSpec / Installation / Deployment と
Installer API です。別 implementation はこの route set ではなく、同じ AppSpec
resolution、retained evidence、lifecycle outcome を満たす別の execution boundary
を持てます。

逆方向の制御 (enroll / heartbeat / lease / drain / gateway manifest) は
[Reference Kernel Route Inventory — Runtime-Agent control RPC](./kernel-http-api.md#runtime-agent-control-rpc)
参照。

## 認証 {#authentication}

| Credential   | Env var                | 適用範囲                            | 認証方式                        |
| ------------ | ---------------------- | ----------------------------------- | ------------------------------- |
| Agent bearer | `TAKOSUMI_AGENT_TOKEN` | `/v1/lifecycle/*`、`/v1/connectors` | `Authorization: Bearer <token>` |

`TAKOSUMI_AGENT_TOKEN` は kernel と runtime-agent が共有する shared secret。
未設定起動の agent は lifecycle / connectors request 全部に 401。 `/v1/health`
のみ無認証で orchestrator probe (Kubernetes / Nomad / docker healthcheck) を想
定。

prepared source を読む connector には、reference dispatcher /
operator-configured kernel が `LifecycleApplyRequest.preparedSource` に resolved
source snapshot の runtime-agent transport locator を載せて渡す場合があります。
`workingDirectory` は co-located / operator-local dispatch 用の transport
locator で、Installer API の `source.kind: "local"` ではありません。portable
remote agent には `url` + `digest` を渡します。prepared handoff では Installer
API は引き続き `source.kind: "prepared"` を受け取ります。runtime file path
は常に AppSpec の kind-specific `spec` にある source-root-relative path です。

operator が optional DataAsset extension として `/v1/artifacts` を mount
しており、DataAsset bytes 取得が必要な connector には、 reference dispatcher /
operator-configured kernel が `LifecycleApplyRequest.artifactStore` に `baseUrl`
と `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を載せて渡す場合があります。この
operator-mounted DataAsset extension は agent token と別の credential family を
使い、scope は optional DataAsset extension の `GET /v1/artifacts/:hash` のみ
([Authentication](./kernel-http-api.md#authentication))。
`artifactStore.baseUrl` は operator-owned artifact endpoint を指してよく、kernel
Installer API process が blob data plane になることを要求しません。

## エンドポイント {#endpoints}

この表の route は reference runtime-agent process / operator-internal host が提
供する execution surface です。すべての path は runtime-agent base URL からの
相対 path です。public Installer API の shape は
[Installer API](./installer-api.md) を正本とします。

| Method | Path                       | Auth        | Purpose                                                              |
| ------ | -------------------------- | ----------- | -------------------------------------------------------------------- |
| GET    | `/v1/health`               | -           | `{ status: "ok", connectors: <count> }`                              |
| GET    | `/v1/connectors`           | Agent token | 起動時に登録された connector-local selector と acceptedArtifactKinds |
| POST   | `/v1/lifecycle/apply`      | Agent token | resource を作成 / 更新                                               |
| POST   | `/v1/lifecycle/destroy`    | Agent token | handle 指定で resource を削除                                        |
| POST   | `/v1/lifecycle/compensate` | Agent token | WAL recovery 用に commit 済み effect を逆再生                        |
| POST   | `/v1/lifecycle/describe`   | Agent token | handle 指定で実体の状態を取得                                        |
| POST   | `/v1/lifecycle/verify`     | Agent token | connector ごとに `verify` operation を smoke test                    |

### `POST /v1/lifecycle/apply`

`LifecycleApplyRequest`:

```ts
interface LifecycleApplyRequest {
  readonly shape: string; // connector-local selector, e.g. "object-store@v1"
  readonly provider: string; // 例: "aws-s3"
  readonly resourceName: string; // component / internal resource name
  readonly spec: JsonValue; // component kind spec (selected implementation convention)
  readonly spaceId: string;
  readonly idempotencyKey?: string; // internal WAL-derived provider request token
  readonly operationRequest?: PlatformOperationRequest;
  readonly metadata?: JsonObject; // request id, audit trail 等
  readonly artifactStore?: {
    // Optional DataAsset fetch endpoint (`/v1/artifacts`) when the operator
    // enables the DataAsset extension.
    readonly baseUrl: string; // 例: "https://artifacts.operator.example.com/v1/artifacts"
    readonly token: string; // TAKOSUMI_ARTIFACT_FETCH_TOKEN
  };
  readonly preparedSource?: {
    readonly url?: string;
    readonly digest?: string;
    readonly workingDirectory?: string;
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

`handle` は reference kernel の retained implementation state に Deployment
と紐づけて persist され、以降の `destroy` / `describe` の key になります。

`spaceId` は caller Installation の Space を表します。runtime-agent connector は
この値を cloud tag、namespace、resource name prefix、audit metadata などの Space
isolation boundary として扱います。別 Space の request で同じ handle を
再利用してはいけません。

WAL-backed lifecycle apply では kernel が internal `PlatformContext.operation`
から `idempotencyKey` / `operationRequest` / `metadata.takosumiOperation` を
envelope に転送します。connector は外部 API が idempotency / client request
token を受け付ける場合、この internal WAL-derived `idempotencyKey` をそのまま
渡します。Installer API には caller-supplied idempotency header はなく、caller
は `expected` guard だけを使います。

### `POST /v1/lifecycle/destroy`

`LifecycleDestroyRequest`:

```ts
interface LifecycleDestroyRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly spaceId: string;
  readonly idempotencyKey?: string; // internal WAL-derived provider request token
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

connector は `destroy` を delete-if-exists な冪等動作として実装します。実体が
既に消えている場合は HTTP 200 + `ok: true` + `note` で返すのが推奨。

WAL-backed lifecycle destroy でも apply と同じ internal key が転送されます。
削除 API に external request token が無い provider は、connector 内部の local
ledger / tag / annotation で同じ key を使って重複 side effect を抑止します。

### `POST /v1/lifecycle/compensate`

`LifecycleCompensateRequest`:

```ts
interface LifecycleCompensateRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly spaceId: string;
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
す。専用 operation が無い connector は handle-keyed `destroy` に fallback。
完全に逆再生できない場合は `revokeDebtRequired: true` を返し、 kernel が
RevokeDebt として保持します。

### `POST /v1/lifecycle/describe`

`LifecycleDescribeRequest`:

```ts
interface LifecycleDescribeRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly spaceId: string;
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

### `POST /v1/lifecycle/verify` {#post-v1-lifecycle-verify}

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
  readonly shape: string; // verify 対象の connector-local selector
  readonly provider: string; // verify 対象の provider id
  readonly ok: boolean; // smoke test 結果 (true = 健全)
  readonly code?: string; // ok=false 時に設定される LifecycleErrorCode
  readonly note?: string; // 詳細メッセージ (operator が読む)
  readonly details?: JsonObject; // connector が返す追加情報 (latency, scope 等)
  readonly latencyMs?: number; // smoke test 所要時間
  readonly checkedAt: string; // ISO 8601 timestamp
}
```

`results[]` は順序保証なし。 caller は connector-local selector で集計します。

## Connector retry / credential refresh {#connector-retry--credential-refresh}

`buildConnectorRegistry()` は connector の lifecycle operation を共通の
resilience wrapper で包みます。 retry 対象は次のみ:

- `HTTP 408` / `425` / `429` / `500` / `502` / `503` / `504`
- `TypeError` / `ECONNRESET` / `ETIMEDOUT` などの network failure
- `retryable: true` を持つ connector error

`HTTP 400` 等の provider validation error、 `retryable: false`、 permission
denied 等の恒久 failure は retry せず。 retry は bounded exponential backoff
で同じ envelope を再投入します。 connector は `idempotencyKey` / provider-native
client token / handle-keyed delete で重複 side effect を抑止します。

credential refresh は opt-in。
`ConnectorBootOptions.resilience.refreshCredentials` を渡した場合のみ、 wrapper
は `HTTP 401` / expired token を検出して refresh を 1 回呼び、同じ operation
を再試行します。 refresh 未設定なら credential error は通常の connector failure
として返ります。

## Lifecycle status の状態機械 {#lifecycle-status-state-machine}

`LifecycleStatus` は reference runtime-agent envelope v1 の中で 5 値の closed
enum です。public Installation / Deployment status は
[Installer API](./installer-api.md#entity-fields) が正本です。

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

- `apply` 成功は `running` に遷移。失敗は `connector_failed` を返し kernel 側で
  `error` projection。
- `destroy` 成功は `missing` に遷移。以降 `describe` も `missing` を返します。
- `describe` は実体 API を毎回叩くので 5 値いずれにも遷移し得ます。 `unknown` は
  rate limit / transient error 等で API が一時応答できない時の予備。
- `verify` は status を materialize しません。 connector credential / network
  reachability の health probe に専念し、結果は
  `LifecycleVerifyResponse.results[].ok` に集約します。

## エラー envelope {#error-envelope}

reference runtime-agent envelope の failure は `LifecycleErrorBody` を 4xx / 5xx
で返します。public Installer API の error envelope は
[Installer API](./installer-api.md#error-envelope) が正本です。

```ts
interface LifecycleErrorBody {
  readonly error: string; // 人間向け message
  readonly code: LifecycleErrorCode; // closed enum + connector-extended:* 予約
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}
```

`code` は reference runtime-agent envelope v1 の closed enum。current reference
implementation では `connector-extended:` prefix を connector 拡張用に予約し、
kernel は共通 error logic に載せず connector の string をそのまま actor に伝え
ます。

| `code`                   | HTTP   | 発生条件                                                                     |
| ------------------------ | ------ | ---------------------------------------------------------------------------- |
| `unauthorized`           | 401    | bearer 不足 / mismatch                                                       |
| `bad_request`            | 400    | request body validation 失敗                                                 |
| `connector_not_found`    | 404    | selector に対応する connector が registry にいない                           |
| `artifact_kind_mismatch` | 400    | DataAsset-backed connector の operator DataAsset metadata と spec が合わない |
| `connector_failed`       | 500    | connector が throw した想定外エラー                                          |
| `connector-extended:*`   | (任意) | connector 拡張用の予約 prefix                                                |

`retryable: true` は network / rate limit / transient cloud failure を表す
フラグ。 kernel は WAL の `pre-commit` / `commit` stage で再試行可否をこれで
分岐します。

## 関連ページ

- [Lifecycle Phases](./lifecycle-phases.md)
- [Connector Guide](./connector-contract.md)
- [Provider Implementations](./providers.md)
- [Enum and Value Index](./closed-enums.md)
