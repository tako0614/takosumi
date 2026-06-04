# Operations: Capacity Planning Baseline

> このページでわかること: Takos operated environments の現 traffic baseline、 1
> 年 growth forecast、headroom 計算、capacity review cadence。

この baseline は public managed Takos launch readiness (ROADMAP.md Managed Takos
Offering gap audit) 用です。Kernel orchestration の実測値は
[Performance Baseline](../../../takos/docs/performance/baseline.md)
を参照します。このページでは Takos product 全体の運用 capacity floor
と、telemetry が集まり始めた後の 更新ルールを固定します。

Takos の主要 customer surface は Web/API です。developer / operator command
traffic は `takosumi` / Takosumi deploy control 側の API call として capacity
review に含めます。

## Current Traffic Baseline

2026-05-07 時点で Takos managed production は pre-GA。customer production
traffic baseline は 0 customer RPS。capacity planning は以下を使う:

- 現行の internal / staging 検証 signal
- `docs/performance/baseline.md` の in-process kernel benchmark
- 最初の public managed 環境向けの launch floor 想定

| Surface                     | Current measured production traffic |         Planning floor for launch | Source                                             |
| --------------------------- | ----------------------------------: | --------------------------------: | -------------------------------------------------- |
| Takos Web/API read traffic  |                      0 customer RPS |                       50 RPS peak | pre-GA baseline + launch floor                     |
| Takos Web/API write traffic |                      0 customer RPS |                       10 RPS peak | pre-GA baseline + launch floor                     |
| Git Smart HTTP traffic      |                      0 customer RPS |                       20 RPS peak | pre-GA baseline + launch floor                     |
| Deploy plan/resolve         |                      0 customer RPS |                        5 RPS peak | kernel API bench supports > 500 RPS target         |
| Deploy apply                |              0 customer applies/min |               30 applies/min peak | provider RPC bound; throttle below provider limits |
| Runtime-agent work queue    |               0 customer work items |           500 queued / 100 active | launch floor                                       |
| Default app routed traffic  |                      0 customer RPS | 50 RPS peak per default app class | launch floor                                       |

launch floor は意図的に current traffic より高めに設定しており、最初の GA 環境で
即時の capacity resizing が不要な水準にしています。

## One-year Forecast

予測 horizon: public managed launch から 12 か月。

前提:

- 月次 peak traffic 成長率: 15 %
- traffic 集中度: 上位 10 % の tenant が requests の 60 % を生成しうる
- deploy traffic は read traffic より緩やかに成長するが、tail latency が高い
- default app は control-plane deploy traffic と独立に burst しうる

計算式:

```text
forecast_peak = max(current_peak, launch_floor) * 1.15^12
required_capacity = forecast_peak * 2.0 headroom
```

`1.15^12` は約 `5.35`。`2.0` の multiplier は regional failover、noisy tenant、
traffic spike の余裕として確保します。

| Surface                     |   Launch floor | 12-month forecast peak | Required headroom capacity |
| --------------------------- | -------------: | ---------------------: | -------------------------: |
| Takos Web/API read traffic  |         50 RPS |                268 RPS |                    536 RPS |
| Takos Web/API write traffic |         10 RPS |                 54 RPS |                    108 RPS |
| Git Smart HTTP traffic      |         20 RPS |                107 RPS |                    214 RPS |
| Deploy plan/resolve         |          5 RPS |                 27 RPS |                     54 RPS |
| Deploy apply                | 30 applies/min |        161 applies/min |            322 applies/min |
| Runtime-agent active work   |     100 active |             535 active |               1,070 active |
| Default app routed traffic  | 50 RPS / class |        268 RPS / class |            536 RPS / class |

## Sizing Baseline

planning 用の各 component の初期 floor と scale trigger:

| Component                | Initial floor               | Scale trigger                                 | Headroom rule                                  |
| ------------------------ | --------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `takos-app` Web/API      | 2 instances per region      | p95 latency > target for 30 min or CPU > 60 % | keep N+1 instance capacity                     |
| `takos-git`              | 2 instances per region      | queue / request p95 > target or CPU > 60 %    | isolate Git Smart HTTP from Web/API            |
| Takosumi API             | 2 instances per region      | deploy plan p95 > target or 5xx > 1 %         | keep deploy plan below 50 % of tested capacity |
| Takosumi worker          | 2 workers per region        | WAL backlog or outbox age above target        | workers can double without DB saturation       |
| Runtime-agent pool       | 2 agents per provider class | active work > 60 % of cap for 15 min          | keep one provider-agent failure domain spare   |
| Postgres / durable store | managed HA tier             | connection pool > 70 % or storage > 65 %      | provision 90 days storage runway               |
| Object/artifact storage  | provider managed            | storage growth > forecast for 7 days          | lifecycle policy reviewed monthly              |

planning に使う per-instance safe capacity (conservative):

| Component                        |                Safe capacity used for planning | Evidence / limit                                      |
| -------------------------------- | ---------------------------------------------: | ----------------------------------------------------- |
| Takosumi deploy plan/resolve API |                             500 RPS / instance | Phase 20C target, below 3,556 RPS loopback result     |
| Takosumi concurrent resolve      |                       50 concurrent / instance | `docs/performance/baseline.md` scaling recommendation |
| Takosumi concurrent apply        |                       20 concurrent / instance | provider RPC bound; keep under provider limits        |
| Takos Web/API                    | 250 RPS / instance until real telemetry exists | launch floor, conservative web/API planning value     |
| Takos Git Smart HTTP             | 100 RPS / instance until real telemetry exists | isolate from Web/API and revisit after staging k6     |
| Runtime-agent active work        |                   50 active work items / agent | launch floor; provider class can override lower       |

## Headroom Checks

capacity review で見る query / signal:

- Web/API の RPS と p95 latency
- Git Smart HTTP の RPS と p95 latency
- deploy 操作数と apply latency
- rollback latency と失敗件数
- runtime-agent の active lease、queue depth、stale heartbeat 数
- DB の CPU、connection pool、lock wait、storage 成長
- object / artifact storage の成長
- tenant 別の top-N 使用集中度

許容できる最小 headroom:

| Resource                  | Warning                         | Action                                            |
| ------------------------- | ------------------------------- | ------------------------------------------------- |
| CPU                       | sustained > 60 %                | add capacity or reduce concurrency                |
| Memory                    | sustained > 70 %                | add capacity / inspect leaks                      |
| DB connections            | sustained > 70 %                | add pool capacity or reduce worker fan-out        |
| Storage                   | > 65 % used or < 90 days runway | expand storage / tighten retention                |
| Runtime-agent active work | > 60 % cap                      | add agents or split provider class                |
| Deploy apply p95          | above SLO for 30 min            | inspect provider latency / throttle / add workers |

required capacity は surface ごとに以下で計算:

```text
design_peak = max(current_30d_p95_peak, launch_floor) * growth_multiplier * burst_multiplier
instance_count = ceil(design_peak / per_instance_safe_capacity)
headroom_ratio = provisioned_safe_capacity / design_peak
```

Release blocker しきい値:

- Web/API および Git の read/write surface: `headroom_ratio < 2.0`
- Background worker と runtime-agent pool: `headroom_ratio < 1.5`
- DB / object storage: 想定 runway が 30 日未満
- 単一 tenant が regional capacity の 50 % 超を消費しうる場合

## Review Cadence

- pre-GA 期間および GA 後 30 日間は週次
- traffic が安定したら月次
- saturation を含む SEV-1 / SEV-2 incident の直後
- 新 default app または新 provider target の有効化前
- 大規模な pricing / quota 変更前

各 review でこのページを更新するか、baseline
が引き続き有効である理由を記録します。

## Update Rule

managed production telemetry が揃った時点で、pre-GA の current traffic 行を 30
日間 p95 peak 実測値に置き換えます。 product planning が成長前提を明示的に
変更しない限り、forecast formula は安定して維持します。

単日の spike を baseline として採用してはいけません。30 日 p95 peak を使い、
最大の単日 spike は別途 stress evidence として記録します。
