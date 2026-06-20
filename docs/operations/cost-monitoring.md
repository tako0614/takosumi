# Operations: Space Billing and Usage Monitoring

> このページでわかること: Takosumi operated environments の cloud spend、
> Space billing、credit usage、Installation attribution、reconciliation cadence。
> canonical billing unit は Space で、Installation は UsageEvent attribution
> dimension です。billing mode は `disabled` / `showback` / `enforce` のいずれかです。

この runbook は hosted Takosumi launch readiness の cost monitoring 正本です。
Takosumi control plane / runner から発生する run traffic は、最終的に
Space-scoped usage として集計します。Installation id は cost drill-down 用の
label であり、請求・credit reservation の正本ではありません。

Dashboard artifact target:

- `takosumi/deploy/observability/grafana/takosumi-cost-attribution.json`

この artifact は hosted billing `enforce` を開く前に Takosumi 側で provision
されている必要があります。Takos product 側の observability artifact を
Takosumi operated billing dashboard の正本として参照してはいけません。

## Scope

**Cost attribution hierarchy** (canonical):

- **Space**: billing plan、credit balance、reservation、usage rollup の正本。
- **Installation**: Space 配下の OpenTofu Capsule 実行単位。UsageEvent の
  attribution dimension。
- **Billing account / payer**: `billing_accounts` / `space_subscriptions` /
  `plans` が保持する payment processor reference。Space billing に紐づくが、
  Run gate の正本ではありません。

billing line item は Space 単位で集計します。Installation id は runner minutes、
Provider Connection attributed run usage、artifact / backup storage、egress などの内訳分析に使います。

Billing mode:

| Mode       | Behavior                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `disabled` | self-host default。usage は operator showback 目的で任意に記録できるが、plan/apply を止めない。     |
| `showback` | estimate / usage / reservation-like evidence を記録するが、credit 不足で apply を止めない。         |
| `enforce`  | hosted Takosumi 用。plan 後に credit reservation を作り、approval/apply で reservation を検証する。 |

対象は Takosumi operated production / staging environments の Space billing と
Installation-attributed usage です。

| Surface                            | Owner                    | Cost source                                                                            |
| ---------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Takosumi runner usage              | Takosumi platform worker | Run ledger + queue / container execution meters                                        |
| Platform resource usage            | Takosumi platform worker | platform control/state/artifact meters joined to Space / Installation attribution      |
| Space provider usage               | User cloud account       | user cloud bill; Takosumi charges runner/control/state/artifact usage only             |
| Custom provider usage              | User provider account    | cost estimate may be unavailable; Takosumi charges runner/control/state/artifact usage |
| Artifact / backup storage usage    | Takosumi platform worker | R2 object inventory joined to Space / Installation attribution                         |
| UsageEvent ingest / reconciliation | Takosumi platform worker | `resource_meter` / `billing_reconciliation` events idempotently joined to Space use    |
| Cloud provider infrastructure      | operator                 | Cloudflare / provider billing export                                                   |

invoice、payment processor reconciliation、secret を含む cloud billing credential は
repo 外の operator vault に残します。本 public doc は observable metric contract と
dashboard artifact のみを定義します。

## Metric Contract

dashboard は managed billing / cloud-cost ETL が生成する Prometheus 互換の counter
を前提とします。counter は累積値で、cost metric は cent 単位、usage metric は
native unit を保ちます。

| Metric                                    | Required labels                             | Source                                                 |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `takosumi_cloud_spend_cents_total`        | `space_id`, `provider`, `service`, `region` | cloud provider bill export joined to Space attribution |
| `takosumi_usage_credits_total`            | `space_id`, `kind`, `mode`                  | Takosumi UsageEvent / credit ledger rollup             |
| `takosumi_installation_usage_units_total` | `space_id`, `installation_id`, `kind`       | Installation-attributed usage rollup                   |

optional な attribution label:

- `cost_center`
- `project_code`
- `customer_segment`
- `plan_id`

attributed spend には `space_id` が必須です。Space に join できない cloud bill 行は、
unattributed spend を dashboard で明示できるよう `space_id=""` で export します。

## Attribution Join

cost attribution は以下の順で適用します:

1. direct resource tag: cloud resource の `space_id` / `takos_space_id`、または
   provider 固有の同等 tag。
2. Takosumi Space attribution label: `takosumi_cost_center` /
   `takosumi_project_code` / `takosumi_customer_segment`。
3. UsageEvent の idempotency key と Space / Installation mapping。
4. fallback として `space_id=""` を使い、provider / service / region / invoice
   line metadata は private billing pipeline 側で保持する。

Takosumi control ledger の正本は Space credit ledger、UsageEvent、CreditReservation
です。operator dashboard は join 済み metric output を consume するだけで、ledger
state は変更しません。

## Dashboard Panels

`takosumi-cost-attribution.json` のパネル:

- 過去 30 日間の cloud spend
- 過去 30 日間の credit usage
- attributed usage の gross margin
- 過去 24 時間の attribution coverage
- cloud spend 上位 Installation
- provider / service 別の cloud spend
- usage 上位 Installation
- meter 別の billed usage
- cost center / project code 別の cloud spend
- 過去 24 時間の unattributed cloud spend

dashboard は `DS_PROMETHEUS` / `space_id` / `provider` の variable を使います。
incident 中に on-call が SLO impact から cost impact に pivot できるよう、deploy
overview dashboard と同じフォルダに provision します。

## Reconciliation

日次:

- attribution coverage を確認する。unattributed spend は日次 cloud spend の 2 %
  未満に保つこと。
- cloud spend / usage の上位 20 Installation を review する。
- cloud spend と usage の両方に fresh sample が存在することを確認する。

月次クローズ:

- operator vault に保管した provider invoice 合計と
  `sum(increase(takosumi_cloud_spend_cents_total[30d]))` を比較する。
- 同じ期間の Takosumi UsageEvent / credit ledger rollup と
  `sum(increase(takosumi_usage_credits_total[30d]))` を比較し、priced billing output
  を operator account-plane の payer / entitlement records と照合する。
- reconciliation 結果を private finance / operations log に記録する。
- provider invoice delta が 1 % を超える、または billing usage delta が 0.5 %
  を超える場合はフォローアップを起票する。

## Alerts

| Alert                    | Condition                                                     | Action                                          |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------- |
| Cost exporter missing    | no samples for 30 minutes                                     | page primary during business hours, SEV-3       |
| Unattributed spend high  | `space_id=""` spend > 2% for 24h                              | block GA promotion until attribution is fixed   |
| Installation spend spike | Installation-attributed spend > 3x its 30-day p95 daily spend | inspect abuse, quota, or noisy service          |
| Negative margin          | gross margin < 0 for 24h on paid plans                        | inspect pricing / provider cost / meter mapping |
| Provider bill drift      | monthly cloud invoice delta > 1%                              | finance + operator reconciliation review        |

## Privacy and Access

dashboard では opaque な `space_id` / `installation_id` / billing account reference
のみを使います。customer email、company name、payment processor customer id、
invoice id、support ticket id を metric label として export してはいけません。
private billing system は ID から customer record に解決しても構いませんが、
Grafana dashboard は operator-facing かつ identifier のみとします。

## Validation

実行:

```bash
cd takosumi
bun run docs:build
```

Plan-time BillingPlan limit enforcement と credit reservation gate は実装済みです。`enforce` は limit 超過または
credit 不足の run を apply 前に block し、`showback` は audit evidence を記録して続行します。Hosted billing `enforce`
の broad production rollout には、Takosumi cost attribution dashboard artifact と validator が本 runbook の metric
contract / dashboard reference を検証する状態が必要です。Platform opening evidence では
`costAttribution.dashboardJsonPath` を
`takosumi/deploy/observability/grafana/takosumi-cost-attribution.json` に固定し、fresh sample、required metrics /
labels、unattributed spend 2% 以下の証跡を private operator evidence に記録します。
