# Lifecycle Protocol

Takosumi の deployment lifecycle (apply / destroy / describe) の挙動を、kernel
側 apply pipeline と runtime-agent 側 connector dispatch の両方の観点から
整理します。 source of truth は以下:

- [`packages/kernel/src/domains/deploy/apply_v2.ts`](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/domains/deploy/apply_v2.ts)
  — DAG / fingerprint / rollback の本体。
- [`packages/kernel/src/api/deploy_public_routes.ts`](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/api/deploy_public_routes.ts)
  — `POST /v1/deployments` のエンドポイント、lock の acquire/release。
- [`packages/kernel/src/domains/deploy/takosumi_deployment_record_store_sql.ts`](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/domains/deploy/takosumi_deployment_record_store_sql.ts)
  — lock semantics の正本コメント。
- [`packages/contract/src/runtime-agent-lifecycle.ts`](https://github.com/tako0614/takosumi/blob/master/packages/contract/src/runtime-agent-lifecycle.ts)
  — kernel ↔ agent envelope。

## High-level flow

```
┌────────┐   POST /v1/deployments              ┌──────────────────────┐
│  CLI   │ ───────────────────────────────────▶│ kernel HTTP          │
│ deploy │   { mode, manifest, force? }        │ ┌──────────────────┐ │
└────────┘                                      │ │ acquireLock(     │ │
                                                │ │   tenant, name)  │ │
                                                │ └──────────────────┘ │
                                                │   ↓                  │
                                                │ ┌──────────────────┐ │
                                                │ │ applyV2(...)     │ │
                                                │ │  resolveResources│ │
                                                │ │  buildRefDag     │ │
                                                │ │  fingerprint /   │ │
                                                │ │  prior snapshot  │ │
                                                │ │  per-resource ↓  │ │
                                                │ └──────────────────┘ │
                                                │   ↓                  │
                                                │ provider.apply(spec) │
                                                │   = HTTP POST to     │
                                                │     runtime-agent    │
                                                └──────────────────────┘
                                                            │
                                  POST /v1/lifecycle/apply  │
                                                            ▼
                                              ┌──────────────────────┐
                                              │ runtime-agent        │
                                              │  dispatcher          │
                                              │  → connector.apply   │
                                              │     (cloud SDK / OS) │
                                              └──────────────────────┘
                                                            │
                                          { handle, outputs}│
                                                            ▼
                                              ┌──────────────────────┐
                                              │ kernel persists      │
                                              │  AppliedResource +   │
                                              │  fingerprint into    │
                                              │  recordStore.upsert  │
                                              │  releaseLock         │
                                              └──────────────────────┘
```

各 hop は **HTTP**:

1. CLI → kernel: bearer-auth な `POST /v1/deployments`
   ([Kernel HTTP API](/reference/kernel-http-api))。
2. kernel → runtime-agent: bearer-auth な
   `POST /v1/lifecycle/{apply,destroy,describe}`
   ([Runtime-Agent API](/reference/runtime-agent-api))。
3. runtime-agent → cloud / OS: connector が SDK や `Deno.Command`
   で実 API を叩く。

## Apply pipeline (`applyV2`)

### Phase 1 — Validation

`resolveResourcesV2(resources)` が manifest の各 resource を
`(shape, provider, spec)` triple に解決します。失敗例:

- `shape: object-store@v1` が registry に無い → `failed-validation`
- `provider:` の id が shape に対する provider として未登録
- `requires:` capability が provider の `capabilities` に含まれない

validation issue が 1 件でもあれば applyV2 は **何も実行せず** に
`status: "failed-validation"` を返します。

### Phase 2 — Ref DAG

`buildRefDag(resources)` が `${ref:other.field}` を辿って依存グラフを
作り、トポロジカル順に並べます。cycle や undefined ref は
`failed-validation` となり、apply には進みません。

### Phase 3 — Per-resource apply (DAG order)

DAG 順にループ。各 resource について:

```ts
const resolvedSpec = resolveSpecRefs(item.resource.spec, {
  outputs: outputsByName,
});
const fingerprint = computeSpecFingerprint(
  item.resource,    // shape, name
  item.provider.id,
  resolvedSpec,     // ref 解決済み spec
);
```

`fingerprint` は **FNV-1a 32-bit** を `sha`-ではなく短いタグ
(`fnv1a32:<hex>`) として算出します。
`shape | providerId | name | JSON.stringify(spec)` を seed にしているため、
**JSON.stringify の key 順** が変われば値も変わります — 同一意味でも
key を入れ替えると一回 re-apply が走ります。これは intentional な v0
trade-off です (手元の docstring 抜粋):

```
The cost of false negatives here is one extra `provider.apply` call,
never correctness.
```

### Phase 4 — Idempotent skip

caller (`POST /v1/deployments`) が `priorApplied` map を渡している場合、
fingerprint と provider id が一致すれば `provider.apply` を **呼ばずに**
保存済みの handle / outputs を再利用します。downstream resource は ref
resolver 経由でこれら outputs を見るので、グラフ全体の整合性は維持されます。

::: tip
v0 では fingerprint **不一致** でも自動的に旧 handle を destroy しません。
古い resource は残ったまま `provider.apply` が呼ばれます。
将来の "delta replace" でこの挙動は変わる予定なので、
**implementation detail として扱ってください**。
:::

### Phase 5 — Failure → rollback

`provider.apply` が throw すると:

1. これまで apply 済みの resource を **逆 DAG 順に best-effort destroy**。
2. destroy が失敗しても外には surface しない (silent catch)。
3. outcome は `failed-apply` で返り、`issues[0]` に
   `apply failed: <message>` を入れる。

::: warning
rollback は **kernel process がクラッシュすると走りません**。プロセス障害で
applied resource list が宙に浮いた場合は、`recordStore` にまだ
`upsert` していない可能性があるため `takosumi destroy` で消せず、
operator が手動で cloud 側を掃除する必要があります。
applied resources の partial state は failure mode の章を参照。
:::

### 永続化

成功時は `outcome.applied[]` を `recordStore.upsert(...)` で保存。
保存される情報は `(tenant, name)` をキーに、manifest + applied resources
(handle / outputs / fingerprint) + status (`applied` | `failed` | `destroyed`)。
SQL backend は migration `20260430000020_takosumi_deployments` の
`takosumi_deployments` テーブル
([SqlTakosumiDeploymentRecordStore](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/domains/deploy/takosumi_deployment_record_store_sql.ts))。

## Destroy

`POST /v1/deployments` mode `destroy`:

1. lock acquire。
2. `recordStore.get(tenant, name)` で prior record を取得。
   record が無ければ **409 を返して拒否** する (`force: true` を渡すと
   `resource.name` を handle として fallback、cloud handle が一致しない
   ことを警告)。
3. `destroyV2(...)` を呼ぶ:
   - 同じ validation / DAG resolution を流す。
   - **逆 DAG 順** に `provider.destroy(handle, ctx)` を呼ぶ
     (依存先が後で消える)。
   - 個別 failure は `errors[]` に積み、全体は continue する。
4. 成功 / 部分成功なら `recordStore.markDestroyed(...)` で row を
   `destroyed` 状態に遷移。
5. lock release。

destroy は **冪等**:

- 既に `destroyed` な record を再 destroy → 再度 best-effort で
  provider に投げる (provider 側の `destroy` も idempotent 前提)。
- handle が cloud から消えていても `provider.destroy` は ok を返すべき。

## Describe (status query)

`POST /v1/deployments` の **describe は別経路** です。kernel 側は
`GET /v1/deployments/:name` で persistent record を返すだけ。
runtime レベルの状態確認は runtime-agent の
`POST /v1/lifecycle/describe` で連鎖的にひかれます:

| connector              | describe の実装                                                   |
| ---------------------- | ----------------------------------------------------------------- |
| AWS / GCP / Azure 系   | 各 SDK の Get / Describe API (例: `DescribeServices`, `Get` task) |
| `cloudflare-container` | Cloudflare Containers API の status fetch                         |
| `docker-compose`       | `docker inspect` を叩いて running / stopped を判定                |
| `systemd-unit`         | `systemctl is-active <unit>` の戻り値で status を決定             |
| `filesystem` 系        | 物理 file の存在確認                                              |

返るのは `LifecycleStatus = "running" | "stopped" | "missing" | "error" | "unknown"`
+ optional `outputs` / `note`。

::: tip
`describe()` が **runtime-agent restart 後でも正しく動く**
理由は、connector が prior apply の outputs ではなく
**実際の cloud / OS state** を毎回問い合わせるから。systemd 系の
docstring にも "authoritative state for `describe()` is the on-disk unit
file plus `systemctl is-active`" と明記されています。
:::

## Concurrency

### In-process

`SqlTakosumiDeploymentRecordStore.acquireLock(tenant, name)` は
**per-key Promise chain** を `Map` で持っており、同じ key に対する
acquire は前の holder が `releaseLock` を呼ぶまで `await` で待ちます。
public deploy route は

```
acquireLock → applyV2 → recordStore.upsert → releaseLock
```

の bracket を `try { ... } finally` で囲っているため、
**1 つの kernel process 内** では同じ deployment の apply / destroy が
シリアライズされます。

### Cross-process

::: warning
**Cross-process / multi-pod での lock は SqlTakosumiDeploymentRecordStore
が保証しません。** Postgres `pg_advisory_lock` は session-scoped で、
pooled な SqlClient だと acquire と release が異なる接続にルーティング
されて lock が漏れるためです。

operator が必要なら以下のいずれかを選びます:
- **Single-writer apply tier**: deploy 系 traffic を 1 pod に固定。
- **Custom SqlClient**: acquire〜release を同一 connection に pin した
  実装を inject し、`SELECT … FOR UPDATE` などの row-level lock を使う。
:::

これは README / docstring レベルで明記された設計上の **既知の gap**
です。 implementation detail ではなく、operator 側で対処する責務として
扱ってください。

## Idempotency

| シナリオ                                         | 振る舞い                                            |
| ------------------------------------------------ | --------------------------------------------------- |
| 同じ manifest を 2 回 apply                      | 2 回目は fingerprint match で `provider.apply` skip |
| spec の field を変更                             | fingerprint mismatch → `provider.apply` を再実行    |
| spec は同じだが key 順を入れ替え                 | (v0) fingerprint mismatch → 再 apply 走る           |
| destroyed → 再 apply                             | record が destroyed 状態でも fingerprint で判定     |
| 別 provider id に切り替え                        | mismatch 扱い、`provider.apply` を再実行 (旧 handle は残る) |

::: tip
"exactly-once on success" は kernel が provider 側の冪等性に依存しています。
connector 実装は `apply()` を resource の **upsert** として、`destroy()` を
**delete-if-exists** として書く必要があります。
([Extending](/extending) — connector 実装の章)
:::

## Failure modes

### Apply 中に `provider.apply` が throw

- すでに applied な resource は逆 DAG 順で **best-effort destroy**。
- `outcome.status: "failed-apply"`, kernel 側は `recordStore.upsert(... status: "failed")`
  で row を残す (status 取得が 404 にならないように)。
- **kernel process が落ちると rollback は走らない** (上記 warning 参照)。

### Runtime-agent unreachable

- kernel は HTTP error を `provider.apply` の throw として認識し、上記
  rollback パスに入ります。
- 部分的に cloud リソースが残る可能性があります。
  `takosumi destroy --force` か手動の cloud cleanup が必要。

### DB unreachable

- `recordStore.upsert` 失敗で apply 結果が persist されない。
  cloud 側 resource は実体としては存在するが、kernel は
  「prior record 無し」として扱うため、次の destroy は 409 を返します
  (上記 destroy 章)。`force: true` で fallback するか record を手動
  復元する必要があります。

### Apply outcome `failed-validation`

- `provider.apply` を **一度も呼ばない** で 400 を返します。
- `applied[]` は空、`issues[]` に validation 詳細。

### Lock contention

- in-process acquire は単に `await` で待つだけ。
- HTTP 側にタイムアウトを実装していないため、長時間 apply 中に
  別 CLI が deploy を投げると後続は **キューに並んで待ちます**。
  必要なら client 側で timeout を設定してください。

## 関連ページ

- [Manifest](/manifest) — `requires:` / `${ref:...}` / `spec.artifact` の書き方
- [Kernel HTTP API](/reference/kernel-http-api) — `POST /v1/deployments` 等
- [Runtime-Agent API](/reference/runtime-agent-api) — apply / destroy /
  describe envelope と connector dispatch
- [Artifact Kinds](/reference/artifact-kinds) — `spec.artifact` の kind 検証経路
- [Operator Bootstrap](/operator/bootstrap) — `recordStore` / `objectStorage`
  の wiring
