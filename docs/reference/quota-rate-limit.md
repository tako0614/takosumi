# Quota and Rate Limit

> このページでわかること: quota と rate limit の設定と適用ルール。

kernel HTTP API v1 の quota モデル、tenant 単位 metering、rate-limit policy を定義する。kernel は raw signal を出すだけで、強制 (block / throttle / alert) は signal を consume する operator policy 層が担う。

::: info Current HTTP status
quota / rate-limit record は service contract field。 現行 kernel HTTP router は `/api/internal/v1/status` を mount せず、`/readyz` も quota near-limit row を出さない。 現行の probe shape は [Readiness Probes](/reference/readiness-probes) を参照。
:::

## Quota model

scope は 2 つあり、優先順位は次のとおり。

1. **Space-level quota** が v1 baseline。dimension は `space:<id>` 単位で勘定する。枯渇は該当 request だけを失敗させ、他 Space に影響しない。
2. **Kernel-global quota** は operator 側 cap。Space-level cap に達していなくても集約負荷の暴走から host を守る。発火しても `severity: warning` の audit signal を出すのみで、稼働中の traffic は止めない。

quota は **new work には fail-closed、inflight には fail-open**。 cap を越えた Space は new deployment と new activation snapshot を拒否されるが、稼働中の operation は継続し read path も維持される。 raw counter は audit event と status endpoint に出すだけで、allow / deny / require-approval mapping は Risk evaluation と同じ policy pack に住む。

## Quota dimensions (closed v1 set)

v1 集合は closed。dimension 追加は `CONVENTIONS.md` §6 RFC を要する。

| Dimension                         | Unit           | Per-Space? | Notes                                                                                                        |
| --------------------------------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `deployment-count`                | count          | yes        | Active (non-destroyed) Deployments per Space.                                                                |
| `active-object-count`             | count          | yes        | Sum of objects bound to the Space's most recent ActivationSnapshot.                                          |
| `artifact-storage-bytes`          | bytes          | yes        | Sum of `DataAsset.bytes` referenced by the Space, after dedup.                                               |
| `journal-volume-bytes-per-bucket` | bytes / bucket | yes        | OperationJournal write volume per fixed time bucket (`TAKOSUMI_QUOTA_JOURNAL_BUCKET_SECONDS`, default 3600). |
| `approval-pending-count`          | count          | yes        | Approval rows in `pending` state.                                                                            |

各 dimension の更新タイミング:

- `deployment-count` / `active-object-count` — `deployment-applied` および `activation-snapshot-created` で更新。
- `artifact-storage-bytes` — `POST /v1/artifacts` の書き込みと artifact GC sweep ([Artifact GC](/reference/artifact-gc) 参照) で更新。
- `journal-volume-bytes-per-bucket` — bucket 境界ごとに更新。
- `approval-pending-count` — `approval-issued` / `approval-consumed` / `approval-invalidated` で更新。

## Per-tenant metering

kernel は raw counter を Space ごとに記録し、 billing 上の主張は持たずに公開する。 billing system は外部で動作し、 metering event を consume する。

- counter の永続化先は [Storage Schema](/reference/storage-schema) で宣言する partition。read-mostly で OperationJournal は使わない。
- metering event は [Audit Events](/reference/audit-events) と同じものを使う。billing reconciliation の authoritative source は audit log であり、live counter はその index にすぎない。
- kernel は billing engine、price book、tenant 単位 invoice surface を **同梱しない**。operator が audit log を billing pipeline に流す。

## Rate-limit policy

rate limit は HTTP edge で適用する。route class が 2 つ、scope が 2 つ。

Route class:

- **Public routes**: `/v1/deployments/*` および `/v1/artifacts/*` (operator-facing CLI surface)。
- **Internal routes**: `/api/internal/v1/*` (operator dashboard、agent、external-participant 管理)。

Scope:

- **Per-Space** — request の auth context から resolve した Space を key にする。Space token で issue した request は Space が払う。
- **Per-actor** — request envelope の actor identity (deploy bearer subject、internal HMAC actor、または `system`) を key にする。

どちらかの scope が cap を越えた時点で reject。response は HTTP `429 Too Many Requests` で、 header は次の通り。

| Header                           | Value                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| `Retry-After`                    | Integer seconds until the next replenishment tick.              |
| `X-Takosumi-RateLimit-Limit`     | Configured cap for the breached scope.                          |
| `X-Takosumi-RateLimit-Remaining` | Remaining tokens at the time of evaluation (always 0 on a 429). |
| `X-Takosumi-RateLimit-Reset`     | RFC 3339 instant when the bucket fully refills.                 |
| `X-Takosumi-RateLimit-Scope`     | `space` or `actor`.                                             |

backoff は client 側で full-jitter exponential backoff を行う。 開始値は `Retry-After`、連続 429 で倍々、 上限は `TAKOSUMI_RATE_LIMIT_BACKOFF_MAX_SECONDS` (default 300)。 kernel 側は retry しない。

## Configuration

operator policy が cap を変更する際に kernel redeploy 不要となるよう、 quota / rate-limit 設定は環境変数で driven。 変数 catalog は [Environment Variables](/reference/env-vars) を参照。

Quota:

| Variable                                          | Type    | Default | Notes                                           |
| ------------------------------------------------- | ------- | ------- | ----------------------------------------------- |
| `TAKOSUMI_QUOTA_DEPLOYMENT_COUNT_PER_SPACE`       | integer | unset   | Cap for `deployment-count`. Unset means no cap. |
| `TAKOSUMI_QUOTA_ACTIVE_OBJECT_COUNT_PER_SPACE`    | integer | unset   | Cap for `active-object-count`.                  |
| `TAKOSUMI_QUOTA_ARTIFACT_STORAGE_BYTES_PER_SPACE` | bytes   | unset   | Cap for `artifact-storage-bytes`.               |
| `TAKOSUMI_QUOTA_JOURNAL_VOLUME_BYTES_PER_BUCKET`  | bytes   | unset   | Cap for `journal-volume-bytes-per-bucket`.      |
| `TAKOSUMI_QUOTA_JOURNAL_BUCKET_SECONDS`           | integer | `3600`  | Bucket size for journal volume.                 |
| `TAKOSUMI_QUOTA_APPROVAL_PENDING_COUNT_PER_SPACE` | integer | unset   | Cap for `approval-pending-count`.               |
| `TAKOSUMI_QUOTA_GLOBAL_*`                         | mixed   | unset   | Kernel-global counterparts for each dimension.  |

Rate limit:

| Variable                                     | Type    | Default  | Notes                                                                      |
| -------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------- |
| `TAKOSUMI_RATE_LIMIT_PUBLIC_PER_SPACE_RPS`   | integer | `10`     | Public-route per-Space requests per second.                                |
| `TAKOSUMI_RATE_LIMIT_PUBLIC_PER_ACTOR_RPS`   | integer | `10`     | Public-route per-actor requests per second.                                |
| `TAKOSUMI_RATE_LIMIT_INTERNAL_PER_SPACE_RPS` | integer | `30`     | Internal-route per-Space rps.                                              |
| `TAKOSUMI_RATE_LIMIT_INTERNAL_PER_ACTOR_RPS` | integer | `30`     | Internal-route per-actor rps.                                              |
| `TAKOSUMI_RATE_LIMIT_BUCKET_BURST`           | integer | `2x rps` | Token-bucket burst capacity.                                               |
| `TAKOSUMI_RATE_LIMIT_BACKOFF_MAX_SECONDS`    | integer | `300`    | Cap for `Retry-After` doubling.                                            |
| `TAKOSUMI_RATE_LIMIT_DISABLE`                | boolean | `false`  | Disables rate limiting. Local mode only; rejected at boot in `production`. |

`unset` は cap が無いことを意味し、ゼロではない。`0` を設定すると boot で reject される。

## Quota exhaustion behavior

kernel は quota 枯渇を **new work には fail-closed、inflight には fail-open** で扱う。

- new `POST /v1/deployments` は、deployment-bound quota を越えていれば HTTP `429 Too Many Requests` で reject される。non-rate dimension (artifact storage、approval pending count、share count) の breach なら HTTP `409 Conflict` + `errorCode: quota_exhausted`。
- new ActivationSnapshot 生成は `active-object-count` 超過で停止する。 対応する Deployment plan は `errorCode: quota_exhausted` で fail closed。既存 ActivationSnapshot と GroupHead pointer は rollback しない。flowing traffic は継続する。
- CPU / storage / bandwidth の counter は `UsageProjectionService` が Space の quota tier 経由で resolve する。記録前に強制する caller は `requireWithinQuota()` を使う。 これは projected over-limit event を、aggregate を更新せず billing usage も forward せず reject する。
- read path (`GET /v1/deployments`、`GET /v1/artifacts/:hash`) は quota 対象外。rate limit はかかるが quota では弾かれない。
- audit event は `journal-volume` quota の下でも意図的に書き続ける。 audit write を reject すると tamper-evidence contract が壊れるため。

quota rejection は offending operation に紐付いた `severity: warning` audit event を出す。 `TAKOSUMI_QUOTA_ALERT_BURST_SECONDS` (default 60) 内に rejection が繰り返されれば `severity: error` に escalate し、operator alerting wire を発火させる。

## Operator visibility

operator は次を通じて quota 状況を可視化する。

- `/api/internal/v1/status` endpoint ([Kernel HTTP API](/reference/kernel-http-api) 参照)。 response の `quota` object に dimension × Space ごとの entry、`rateLimit` object に bucket fill level が入る。
- `/readyz` probe ([Readiness Probes](/reference/readiness-probes) 参照)。 kernel-global quota が `TAKOSUMI_QUOTA_NEAR_LIMIT_FRACTION` (default `0.9`) 以内に入ると `near-limit` warning row を出す。probe 自体は `ok` のまま、traffic を奪わずに operator の注意を引く。
- Per-Space quota drill-down は operator internal tooling 側の領分。 現行 public `takosumi` CLI に quota subcommand は無い。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — quota signal を consume する operator policy 層。
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` — journal volume の accounting と journal-volume quota dimension。
- `docs/reference/architecture/space-model.md` — per-tenant metering を scope する Space identity。
- `docs/reference/architecture/exposure-activation-model.md` — quota 枯渇下の ActivationSnapshot 生成に適用される fail-safe-not-fail-closed stance。

## 関連ページ

- [Environment Variables](/reference/env-vars)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Audit Events](/reference/audit-events)
- [Readiness Probes](/reference/readiness-probes)
- [Storage Schema](/reference/storage-schema)
