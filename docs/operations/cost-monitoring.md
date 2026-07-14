# Operations: OSS Showback Ledger

> このページでわかること: Takosumi OSS の `disabled` / `showback` を、実在する
> `RunCost` と `UsageEvent` だけで確認する方法。payment、credit、invoice、公式単価、
> provider bill attribution はこの runbook の対象外です。

Takosumi OSS は commercial cost-attribution system を提供しません。OSS が所有するのは、
OpenTofu Run の非 secret な見積もりと、Workspace に記録された provider-neutral な
showback ledger です。架空の cloud spend metric や固定 Grafana dashboard を GA 条件にせず、
control-plane API と永続化された ledger を運用上の正本にします。

## Boundary

| Surface                                    | OSS Takosumi                 | Host extension / Takosumi Cloud                      |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------------- |
| Workspace setting                          | `disabled` / `showback`      | OSS settingを入力として利用可能                      |
| Plan estimate                              | `RunCost.estimatedUsdMicros` | injected `ShowbackRater` が価格を決定                |
| Successful apply usage                     | `UsageEvent`                 | 独自meterの `UsageEvent` を追加可能                  |
| Rating evidence                            | `ratingStatus`               | `rated` の根拠を non-secret audit に追加可能         |
| Apply blocking                             | しない                       | injected `BillingEnforcement` / `QuotaPolicy` が所有 |
| Plan、balance、credit、payment、invoice    | 所有しない                   | commercial host が所有                               |
| Provider invoice / cloud spend attribution | 所有しない                   | operator-private finance pipeline が所有             |

Cloud の official billing evidence を OSS production-hardening evidence に混ぜません。
Cloud は公開 contract の composition port を実装できますが、OSS は Cloud の commercial
ledger、metric名、dashboard、payment providerを知りません。

## Canonical data

### Billing setting

- `disabled` は self-host default です。Core は Run を止めず、自動の showback estimate / apply
  usage event を作りません。
- `showback` は plan measurement と successful apply usage を記録します。host rater
  未注入の OSS default は金額を推測せず `usdMicros: 0` / `ratingStatus: "unrated"`
  とします。enforcement / quota port は常に許可し、残高や支払状態で Run を止めません。

API:

- `GET /internal/v1/workspaces/:workspaceId/billing`
- `PATCH /internal/v1/workspaces/:workspaceId/billing`

### RunCost

`GET /internal/v1/runs/:runId/cost` は plan Run の次の public projection を返します。

- `runId`
- `billingMode`: `disabled` または `showback`
- `estimatedUsdMicros`
- `ratingStatus`: `not_applicable` / `rated` / `unrated`
- `blocked`
- `reasons`
- optional non-secret `extension`

OSS-only composition では commercial balance / reservation / plan / payment semantics を
`extension` から推測しません。operator UI や exporter も同じ原則を守ります。

### UsageEvent

`GET /internal/v1/workspaces/:workspaceId/usage` は cursor pagination された `UsageEvent` を返します。
canonical attribution field は次です。

- required: `id`, `workspaceId`, `kind`, `quantity`, `usdMicros`,
  `ratingStatus`, `source`, `idempotencyKey`, `createdAt`
- optional: `capsuleId`, `runId`, `meterId`, `resourceFamily`, `resourceId`,
  `operation`, `resourceMetadata`

Core は `showback` の successful apply に `source: "runner"` / `kind: "opentofu.apply"`
を記録します。host や installed meter は open token の `source` / `kind` / `meterId` を使えます。
新しい provider や runtime の追加に Takosumi contract release を要求しません。
`ratingStatus: "unrated"` は必ず `usdMicros: 0` です。明示的な price policy が
0 と評価した event は `ratingStatus: "rated"` なので区別できます。
Capsule 単位の usage summary も `ratedEventCount` / `unratedEventCount` を返します。
dashboard や exporter は `unratedEventCount` を金額 0 や無料利用として表示・集計してはいけません。

`idempotencyKey` は producer の再送で二重計上しないための authority です。集計側は event id
や時刻だけで重複排除してはいけません。

## Operational checks

1. Workspace の mode が意図した `disabled` / `showback` か確認する。
2. plan review で対象 Run の `RunCost` を取得し、mode、estimate、rating evidence を記録する。
3. `showback` の apply 成功後、Workspace usage ledger に同じ Run / Capsule の event が一度だけ
   追加されたことを確認する。
4. pagination cursor を最後まで読み、期間集計は `createdAt`、`usdMicros`、
   `ratingStatus` を用いる。`unrated` を無料利用額として集計しない。
5. source別集計では未知の token を拒否せず、opaque dimension として保持する。

例 (operator bearer の取得方法は platform deploy runbook に従う):

```bash
curl -fsS \
  -H "Authorization: Bearer ${TAKOSUMI_DEPLOY_CONTROL_TOKEN}" \
  "${TAKOSUMI_ORIGIN}/internal/v1/runs/${RUN_ID}/cost"

curl -fsS \
  -H "Authorization: Bearer ${TAKOSUMI_DEPLOY_CONTROL_TOKEN}" \
  "${TAKOSUMI_ORIGIN}/internal/v1/workspaces/${WORKSPACE_ID}/usage?limit=100"
```

## Export and alerts

Prometheus / OTLP / warehouse export は operator-owned adapter です。exporter を作る場合も、
実在する `UsageEvent` / `RunCost` から生成し、OSS が提供していない cloud bill、credit、margin を
合成しません。metric 名や dashboard は public Takosumi contract ではありません。

最低限の運用 alert は ledger truth から導出できます。

- `showback` で apply が成功したのに対応する runner UsageEvent がない
- 同じ `idempotencyKey` に異なる payload が観測された
- UsageEvent が存在しない Run / Capsule / Workspace を参照する
- `quantity` / `usdMicros` が不正、または集計値が ledger 再計算と一致しない

provider invoice reconciliation、gross margin、unattributed cloud spend、paid-plan enforcement は
commercial host の private runbook / dashboard で扱います。それらを OSS readiness や
`takosumi/deploy/observability` の必須 artifact に戻してはいけません。

## Validation

```bash
cd takosumi
bun test \
  ./tests/core/api/billing_routes_test.ts \
  ./tests/core/domains/deploy-control/store_billing_security_d1_test.ts
bun run check
```

production hardening gate は runner、control-plane、egress、restore、CredentialRecipe、secret boundary
を検証します。showback は通常の API / ledger test と operator drill で検証し、Workspace access を
架空の cost-attribution metric sample に依存させません。
