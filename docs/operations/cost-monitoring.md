# Operations: Cost Monitoring and Installation Attribution

> このページでわかること: Takos operated environments の cloud spend を
> Installation / Space 単位で追跡する dashboard、metric contract、
> reconciliation cadence。canonical hierarchy は Takosumi Account → Space →
> Installation で、billing / cost は Installation-scoped です。

この runbook は public managed Takos launch readiness (ROADMAP.md Managed Takos
Offering gap audit) の cost monitoring 正本です。Takos の primary customer
surface は Web/API であり、operator command traffic は独立した customer capacity
/ cost surface として扱いません。`takosumi` / Takosumi deploy control から発生する
deploy traffic は、最終的に Takos Web/API または Takosumi API の Space-scoped
usage として集計します。

Dashboard artifact:

- `deploy/observability/grafana/takos-cost-attribution.json`

## Scope

**Cost attribution hierarchy** (canonical):

- **Takosumi Account** (legal billing party): invoice payer
- **Space** (Account 配下、personal / team / org): organization unit
- **Installation** (Space 配下、各 app 1 instance): primary cost attribution
  unit

billing line item は Installation 単位で計上、Space で集計、Takosumi Account の
invoice に統合されます。

対象は Takos-operated production / staging environments の Installation /
Space-attributed cost です。

| Surface                       | Owner                                              | Cost source                                        |
| ----------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `takos-app` Web/API metering  | Takos product                                      | app-local `app_usage_events` / `app_usage_rollups` |
| Takos billing reconciliation  | in-process account plane (Takosumi)                | private billing ledger + app usage rollup join     |
| `takos-git` Smart HTTP        | Takos product                                      | request / storage / transfer exporter              |
| `takos-agent` execution       | Takos product                                      | `exec_seconds`, queue, model/tool meters           |
| Takosumi deploy lifecycle     | in-process deploy control signals                  | Space-scoped usage + provider bill join            |
| Default apps                  | owning app repo                                    | route / storage / runtime usage exporter           |
| Cloud provider infrastructure | operator                                           | Cloudflare billing export                          |

invoice、payment processor reconciliation、secret を含む cloud billing
credential は repo 外の operator vault に残します。 本 public doc は observable
metric contract と dashboard artifact のみを定義します。

## Metric Contract

dashboard は managed billing / app-usage / cloud-cost ETL が生成する Prometheus
互換の counter を前提とします。counter は累積値で、cost metric は cent
単位、usage metric は native unit を保ちます。

| Metric                                 | Required labels                              | Source                                                                                |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `takos_cloud_spend_cents_total`        | `space_id`, `provider`, `service`, `region`  | cloud provider bill export joined to Space attribution                                |
| `takos_billing_usage_cost_cents_total` | `space_id`, `account_id`, `meter_type`       | in-process account-plane billing ledger reconciliation (Takosumi)                     |
| `takos_app_usage_units_total`          | `space_id`, `owner_account_id`, `meter_type` | Takos app `app_usage_events.units` / `app_usage_rollups.units`                        |

optional な attribution label:

- `cost_center`
- `project_code`
- `customer_segment`
- `plan_id`

attributed spend には `space_id` が必須です。 Space に join できない cloud bill
行は、unattributed spend を dashboard で明示できるよう `space_id=""` で export
します。

## Attribution Join

cost attribution は以下の順で適用します:

1. direct resource tag: cloud resource の `space_id` / `takos_space_id`、 または
   provider 固有の同等 tag。
2. Takosumi Space attribution label: `takosumi_cost_center` /
   `takosumi_project_code` / `takosumi_customer_segment`。
3. Takos app の `owner_account_id` と Space usage mapping。
4. fallback として `space_id=""` を使い、provider / service / region / invoice
   line metadata は private billing pipeline 側で保持する。

kernel 側 metadata contract は `takosumi/docs/reference/cost-attribution.md`
が正本です。 Takos dashboard は join 済み metric output を consume するだけで、
kernel attribution state は変更しません。

## Dashboard Panels

`takos-cost-attribution.json` のパネル:

- 過去 30 日間の cloud spend
- 過去 30 日間の billed usage
- attributed usage の gross margin
- 過去 24 時間の attribution coverage
- cloud spend 上位 Installation
- provider / service 別の cloud spend
- billed usage 上位 Installation
- meter 別の billed usage
- cost center / project code 別の cloud spend
- 過去 24 時間の unattributed cloud spend

dashboard は `DS_PROMETHEUS` / `space_id` / `provider` の variable を使います。
incident 中に on-call が SLO impact から cost impact に pivot できるよう、
deploy overview dashboard と同じフォルダに provision します。

## Reconciliation

日次:

- attribution coverage を確認する。unattributed spend は日次 cloud spend の 2 %
  未満に保つこと。
- cloud spend / billed usage の上位 20 Installation を review する。
- cloud spend と billing usage の両方に fresh sample が存在することを確認する。

月次クローズ:

- operator vault に保管した provider invoice 合計と
  `sum(increase(takos_cloud_spend_cents_total[30d]))` を比較する。
- 同じ期間の Takos app `app_usage_rollups.units` と
  `sum(increase(takos_app_usage_units_total[30d]))` を比較し、priced billing
  output を operator account-plane の Installation ledger (本 deployment では
  takosumi 上で動く Takosumi Accounts) と比較する。
- reconciliation 結果を private finance / operations log に記録する。
- provider invoice delta が 1 % を超える、または billing usage delta が 0.5 %
  を超える場合はフォローアップを起票する。

## Alerts

| Alert                    | Condition                                          | Action                                          |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------- |
| Cost exporter missing    | no samples for 30 minutes                          | page primary during business hours, SEV-3       |
| Unattributed spend high  | `space_id=""` spend > 2% for 24h                   | block GA promotion until attribution is fixed   |
| Installation spend spike | Installation spend > 3x its 30-day p95 daily spend | inspect abuse, quota, or noisy workload         |
| Negative margin          | gross margin < 0 for 24h on paid plans             | inspect pricing / provider cost / meter mapping |
| Provider bill drift      | monthly cloud invoice delta > 1%                   | finance + operator reconciliation review        |

## Privacy and Access

dashboard では opaque な `space_id` / `owner_account_id` / Account label のみを
使います。customer email、company name、payment processor customer id、 invoice
id、support ticket id を metric label として export してはいけません。 private
billing system は ID から customer record に解決しても構いませんが、 Grafana
dashboard は operator-facing かつ identifier のみとします。

## Validation

実行:

```bash
cd takos
bun run validate:observability
```

validator は Grafana JSON dashboard を parse し、cost attribution dashboard が
本 runbook から参照され続けていることを確認します。
