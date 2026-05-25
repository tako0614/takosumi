# ロギング規約 {#logging-conventions}

::: info 現在の実装状況

Takosumi HTTP request correlation middleware は current:

- API response は `x-request-id` と `x-correlation-id` を echo。どちらも無ければ `req_<uuid>` を生成。
- staging / production と `TAKOSUMI_HTTP_REQUEST_LOGS=true` の他環境では、 bootstrap path が `requestId` / `correlationId` / `trace_id` / `span_id` / route / status / duration を持つ JSON request log を 1 行 emit。
- installer / optional asset extension metrics も inbound request / correlation id を carry。
- 非 HTTP log への trace id / span id enrichment は今後の target contract。

:::

## 行フォーマット {#line-format}

すべてのログ行は 1 行の JSON object で、`\n` で終端します。複数行のログ行、本番での plaintext fallback、埋め込み null バイトは許可されません。

```text
{"ts":"2026-05-05T10:00:00.123Z","level":"info","subsystem":"kernel","msg":"apply started","spaceId":"sp_01H...","operationId":"op_01H..."}
```

Takosumi は process 終了を跨いでログ行を buffer しない。shutdown を ack する前にすべての行が flush される。

## 必須フィールド {#required-fields}

すべての行は以下のフィールドを持ちます。

| Field       | Type   | 説明                                                                                                                           |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `ts`        | string | RFC 3339 UTC、ミリ秒精度 (Time / Clock Model 参照)。                                                                           |
| `level`     | string | closed enum: `debug`、`info`、`warn`、`error`、`fatal`。                                                                       |
| `msg`       | string | event の human-readable summary。命令形、現在時制。                                                                            |
| `subsystem` | string | closed enum: `kernel`(Takosumi 本体)、`runtime-agent`、`cli`、`implementation`。reference adapter は `implementation` を使う。 |

加えて、operation に関連する行は以下の correlation field のうち**少なくとも 1 つ** を持ちます:

| Field         | 存在条件                                   |
| ------------- | ------------------------------------------ |
| `requestId`   | HTTP request handler 内で emit された行。  |
| `operationId` | OperationPlan の処理中に emit された行。   |
| `eventId`     | audit event 書込みと同時に emit された行。 |
| `spaceId`     | 単一 Space 内で動作する行。                |

4 つの correlation field をいずれも持たない行は、boot、shutdown、global periodic worker tick でのみ許可されます。

## 禁止フィールド {#forbidden-fields}

次のものはログ出力に決して現れてはならない。

- **raw secret 値。** secret を含むべき行は代わりに secret reference (`secret://<partition>/<key>`) を持つ。Takosumi の log writer は emit 時に active な secret-partition redaction set を使ってこれを強制する。
- **raw PII 値。** email、IP、actor 名、類似の PII は active な compliance regime に従って redact される (redaction surface は [Secret Partitions](./secret-partitions.md) を参照)。デバッグに PII が必要な行は値ではなく digest を持つ。

canonical bytes が redaction substring に一致する行は emit 時に reject され、 `level: warn`、`msg: "log redaction triggered"`、問題のあるフィールド名を持つ `severity: warn` 行として surface される。元の行は破棄される。

## ログレベル境界 {#log-level-boundaries}

level enum は closed。隣接 level 間の意味境界は normative。level を誤適用することは Takosumi 実装バグである。

- **debug** — operator の詳細トラブルシューティング専用。本番ではデフォルト off。例: `commit` 内の per-stage trace、per-row storage query、per-message poll loop tick。
- **info** — 安定した本番で operator が見ることを期待する lifecycle event。例: `apply started`、`apply completed`、`operator publication refreshed`、 `lock acquired`、`compaction started`。installation は安定した低レートの `info` 行ストリームを生成する。
- **warn** — 進行を阻害しないが、早期の operator 注意を要する異常。例: drift 検出、approval 期限切れ間近、quota 上限間近、tolerance 内の clock skew、 transition warning の使用。
- **error** — 単一の operation を阻害するが Takosumi を阻害しない operation 失敗。例: operation 失敗、外部システムの reject、CleanupBacklog 作成、単一 operation に対する runtime-agent 到達不能。
- **fatal** — Takosumi が続行不能。例: storage 到達不能、audit-store integrity 失敗、signature verification 失敗、lock leak 検出、secret partition 回復不能。 `fatal` 行の後に orderly な process exit が続く。

## 出力先 {#output-sink}

Takosumi はログを **stdout** に書く (`error` と `fatal` は **stderr**)。 Takosumi 自身はログを rotate / 圧縮 / 出荷しない。

- 12-factor: operator の container runtime が stdout / stderr を capture し、 structured collector (Loki、Fluentd、OpenSearch、CloudWatch 等) に転送する。
- rotation は sink の責務。Takosumi は無制限のストリームを生成し、sink が rotate する。
- file output は operator の container runtime が stdout / stderr を redirect して設定する。

## Audit event との関係 {#relationship-to-audit-events}

log と audit event は異なる保証を持つ別の surface である。

- **audit event** は tamper-evident で、hash-chain され、索引され、retention で管理され、compliance evidence として消費される。taxonomy は closed で [Audit Events](./audit-events.md) に定義される。
- **ログ** は operator のデバッグ surface である。対応する audit event より豊富な context を持ちうるが、audit event を置き換えることはない。

監査可能な Takosumi の決定は必ず最初に audit event を生成し、対応するログ行は情報目的である。incident を調査する operator は `operationId` や `eventId` を通じてログから audit event に pivot する。

## Trace 相関 {#trace-correlation}

相関 middleware が emit する各 Takosumi HTTP request ログには、アクティブな request span の `trace_id` と `span_id` フィールドが含まれる。これらは OTLP の hex 文字列形式を使うため、sink は追加エンコードなしにログを trace と紐付けられる。

```text
"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"
```

アクティブな span の外で emit されるログは空文字列を出すのではなくフィールド自体を省略する。

## Operator 設定 {#operator-configuration}

Takosumi は次のログ関連環境変数を読む。

| Variable                     | Type | Default                                  | Notes                                                                                          |
| ---------------------------- | ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `TAKOSUMI_LOG_LEVEL`         | enum | `info`                                   | Closed enum `debug` / `info` / `warn` / `error` / `fatal`. Lines below this level are dropped. |
| `TAKOSUMI_LOG_FORMAT`        | enum | `json` (production) / `text` (local)     | Closed enum `json` / `text`. Production deployments require `json`.                            |
| `TAKOSUMI_HTTP_REQUEST_LOGS` | bool | `true` in staging/production, else false | Enables JSON Takosumi HTTP request logs outside managed environments when set to `true`.       |

`production` と `staging` では `TAKOSUMI_LOG_FORMAT=text` は boot 時に reject されます。text output は `local` と `development` でのみ許可されます。

CLI は自身のログ発行に同じ環境変数を読む。CLI 行は `subsystem: cli` を持つ。 runtime-agent も同じ環境変数を読み、`subsystem: runtime-agent` を発行する。

## Subsystem ごとの規約 {#per-subsystem-conventions}

共有 envelope に加えて、各 subsystem は次の狭い追加規則に従う。

- **kernel** (Takosumi 本体) — HTTP 境界を跨ぐすべての行は `route` (一致した route template、resolved URL ではない) と `status` (整数としての HTTP status code) を持つ。
- **runtime-agent** — すべての行は `agentId` を持ち、外部 connector が scope にあるときは `connector` (credential ではなく `kubernetes`、`docker`、 `cloudflare` のような短い識別子) を持つ。
- **cli** — すべての行は `command` (dotted CLI command path、例: `deploy.run`、`audit.verify`) と `argvDigest` (redaction 後の argument vector の digest、raw argv ではない) を持つ。
- **implementation** — operator が attach した binding code から emit されるすべての行は `implementationBindingId` を持ち、関連する場合は resolved kind URI / connector id を持つ。reference kernel は reference-adapter 固有のフィールドとして `pluginId` も含みうる。

これらのフィールドは付加的: HTTP `requestId` を既に持つ行も、`kernel` subsystem から発行される際は `route` と `status` を持つ。

## サンプリング {#sampling}

ログは sample されない。Takosumi が emit すると決めた `info` 以上の行はすべて sink に書かれる。sampling があるなら collector の責務であり、ingest 後に適用される。

暴走 debug 出力が sink を埋め尽くさないよう、`debug` 行は Takosumi 内で per- subsystem の rate limit を受けうる。limiter は超過分の `debug` 行を黙って drop し、drop 数を `takosumi_log_debug_dropped_count` で公開する。

## 関連アーキテクチャ {#related-architecture-notes}

- `reference/architecture/operator-boundaries` — operator trust model における log sink の配置と redaction trust boundary。
- `reference/drift-detection` — observation log と CleanupBacklog taxonomy の関係。
- `reference/architecture/approval-model` — error / fatal の closed DomainErrorCode enum へのマッピング。

## 関連ページ

- [Telemetry / Metrics](./telemetry-metrics.md)
- [Audit Events](./audit-events.md)
- [Time / Clock Model](./time-clock-model.md)
- [Secret Partitions](./secret-partitions.md)
- [Environment Variables](./env-vars.md)
