# Operations: Workspace Cost Showback and Quota Monitoring

> このページでわかること: Takosumi operated environments の cloud spend、
> Workspace showback、quota usage、Capsule attribution、reconciliation cadence。
> canonical attribution unit は Workspace で、Capsule は Run attribution
> dimension です。OSS/operator cost mode は `disabled` / `showback` のいずれかです。

この runbook は Takosumi for Operators の cost monitoring / showback readiness の正本です。
Takosumi control plane / runner から発生する run traffic は、最終的に
Workspace-scoped usage として集計します。Capsule id は cost drill-down 用の
label であり、payment / official billing の正本ではありません。

Dashboard artifact target:

- `takosumi/deploy/observability/grafana/takosumi-cost-attribution.json`

この artifact は operator showback / quota readiness evidence として Takosumi 側で provision
されている必要があります。Takos product 側の observability artifact を
Takosumi operated cost dashboard の正本として参照してはいけません。

Takosumi Cloud official billing, enforced payment gates, usage metering sold as a service, support, and abuse workflows
are Cloud-only closed features. Public OSS/operator docs may describe disabled/showback cost evidence and basic quota,
but must not present official billing as part of Takosumi OSS or Takosumi for Operators.

## Scope

**Cost attribution hierarchy** (canonical):

- **Workspace**: quota/showback policy、usage rollup、audit scope の正本。
- **Project**: product/service grouping for cost slicing.
- **Capsule**: Workspace / Project 配下の OpenTofu Capsule 実行単位。Run usage の
  attribution dimension。
- **Cloud-only billing account / payer**: Takosumi Cloud private commercial records. They are not part of the OSS
  control-plane contract or the Run gate.

showback line item は Workspace 単位で集計します。Capsule id は runner minutes、
Provider Connection attributed run usage、artifact / backup storage、egress などの内訳分析に使います。

Cost mode:

| Mode       | Behavior                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `disabled` | self-host default。usage は operator showback 目的で任意に記録できるが、plan/apply を止めない。 |
| `showback` | estimate / usage / quota evidence を記録するが、payment / quota 不足で apply を止めない。       |

対象は Takosumi operated production / staging environments の Workspace showback と
Capsule-attributed usage です。

| Surface                          | Owner                    | Cost source                                                                            |
| -------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Takosumi runner usage            | Takosumi platform worker | Run ledger + queue / container execution meters                                        |
| Platform resource usage          | Takosumi platform worker | platform control/state/artifact meters joined to Workspace / Capsule attribution       |
| Workspace provider usage         | User cloud account       | user cloud bill; OSS Takosumi records showback/control/state/artifact evidence only    |
| Custom provider usage            | User provider account    | cost estimate may be unavailable; OSS Takosumi records showback/control/state evidence |
| Artifact / backup storage usage  | Takosumi platform worker | object inventory joined to Workspace / Capsule attribution                             |
| Showback ingest / reconciliation | Takosumi platform worker | resource meters idempotently joined to Workspace use                                   |
| Cloud-only compat managed usage  | Takosumi Cloud closed    | Cloud extension usage reports joined to Workspace usage ledger                         |
| Cloud provider infrastructure    | operator                 | Cloudflare / provider invoice/export                                                   |

invoice、payment processor reconciliation、secret を含む official billing credential は
repo 外の operator vault に残します。本 public doc は observable metric contract と
dashboard artifact のみを定義します。
Cloudflare Compatibility Gateway / Takosumi Managed Resources の請求可能性は
Cloud-only extension smoke で usage ledger event を確認する必要があります。
Cloudflare の上流請求書だけでは Workspace への請求・showback が成立した証拠にはなりません。

## Metric Contract

dashboard は operator showback / cloud-cost ETL が生成する Prometheus 互換の counter
を前提とします。counter は累積値で、cost metric は cent 単位、usage metric は
native unit を保ちます。

| Metric                                | Required labels                                               | Source                                               |
| ------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `takosumi_provider_spend_cents_total` | `workspace_id`, `project_id`, `provider`, `service`, `region` | provider bill/export joined to Workspace attribution |
| `takosumi_showback_units_total`       | `workspace_id`, `project_id`, `kind`, `mode`                  | Takosumi Run / quota / showback rollup               |
| `takosumi_capsule_usage_units_total`  | `workspace_id`, `project_id`, `capsule_id`, `kind`            | Capsule-attributed Run usage rollup                  |

optional な attribution label:

- `cost_center`
- `project_code`
- `customer_segment`
- `plan_id`

attributed spend には `workspace_id` が必須です。Workspace に join できない cloud bill 行は、
unattributed spend を dashboard で明示できるよう `workspace_id=""` で export します。

## Attribution Join

cost attribution は以下の順で適用します:

1. direct resource tag: cloud resource の `workspace_id` / `takosumi_workspace_id`、または
   provider 固有の同等 tag。
2. Takosumi Workspace attribution label: `takosumi_cost_center` /
   `takosumi_project_code` / `takosumi_customer_segment`。
3. Run / AuditEvent の idempotency key と Workspace / Project / Capsule mapping。
4. fallback として `workspace_id=""` を使い、provider / service / region / invoice
   line metadata は operator-private cost pipeline 側で保持する。

Takosumi control ledger の正本は Workspace quota/showback ledger、Run、AuditEvent
です。operator dashboard は join 済み metric output を consume するだけで、ledger
state は変更しません。

## Dashboard Panels

`takosumi-cost-attribution.json` のパネル:

- 過去 30 日間の cloud spend
- 過去 30 日間の showback usage
- attributed usage の gross margin
- 過去 24 時間の attribution coverage
- cloud spend 上位 Capsule
- provider / service 別の cloud spend
- usage 上位 Capsule
- meter 別の showback usage
- cost center / project code 別の cloud spend
- 過去 24 時間の unattributed cloud spend

dashboard は `DS_PROMETHEUS` / `workspace_id` / `project_id` / `provider` の variable を使います。
incident 中に on-call が SLO impact から cost impact に pivot できるよう、deploy
overview dashboard と同じフォルダに provision します。

## Reconciliation

日次:

- attribution coverage を確認する。unattributed spend は日次 cloud spend の 2 %
  未満に保つこと。
- cloud spend / usage の上位 20 Capsule を review する。
- cloud spend と usage の両方に fresh sample が存在することを確認する。

月次クローズ:

- operator vault に保管した provider invoice 合計と
  `sum(increase(takosumi_cloud_spend_cents_total[30d]))` を比較する。
- 同じ期間の Takosumi Run / quota/showback rollup と
  `sum(increase(takosumi_showback_units_total[30d]))` を比較し、operator account-plane の
  entitlement/quota records と照合する。
- reconciliation 結果を private finance / operations log に記録する。
- provider invoice delta が 1 % を超える、または showback usage delta が 0.5 %
  を超える場合はフォローアップを起票する。

## Alerts

| Alert                   | Condition                                                | Action                                          |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Cost exporter missing   | no samples for 30 minutes                                | page primary during business hours, SEV-3       |
| Unattributed spend high | `workspace_id=""` spend > 2% for 24h                     | block GA promotion until attribution is fixed   |
| Capsule spend spike     | Capsule-attributed spend > 3x its 30-day p95 daily spend | inspect abuse, quota, or noisy service          |
| Negative margin         | gross margin < 0 for 24h on paid plans                   | inspect pricing / provider cost / meter mapping |
| Provider bill drift     | monthly cloud invoice delta > 1%                         | finance + operator reconciliation review        |

## Privacy and Access

dashboard では opaque な `workspace_id` / `project_id` / `capsule_id` / account-plane reference
のみを使います。customer email、company name、payment processor customer id、
invoice id、support ticket id を metric label として export してはいけません。
operator-private cost system は ID から customer record に解決しても構いませんが、
Grafana dashboard は operator-facing かつ identifier のみとします。

## Validation

実行:

```bash
cd takosumi
bun run docs:build
```

Operator showback / basic quota validation は `showback` audit evidence を記録して続行することを前提にします。
Payment/credit enforcement is Takosumi Cloud-only and must not be presented as an OSS/operator feature. Takosumi cost
attribution dashboard artifact と validator が本 runbook の metric contract / dashboard reference を検証する状態が必要です。
Cloud-only compat managed-resource usage は
`smoke:cloud-extensions --require-cloudflare-compat-usage-ledger` で
`resource_meter` / `gateway_compute` または `gateway_storage_gb_hour` が
対象 Workspace ledger に増えたことを private evidence として残します。
Platform opening evidence では
`costAttribution.dashboardJsonPath` を
`takosumi/deploy/observability/grafana/takosumi-cost-attribution.json` に固定し、fresh sample、required metrics /
labels、unattributed spend 2% 以下の証跡を private operator evidence に記録します。
