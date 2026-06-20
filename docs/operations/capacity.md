# Operations: Capacity Planning Baseline

> このページでわかること: Takosumi operated environments の traffic baseline、
> OpenTofu runner capacity、D1/R2/Queue headroom、capacity review cadence。

この baseline は Takosumi platform worker (`app.takosumi.com`) の capacity
planning 正本です。Takosumi を embedded compose する host/distribution
product worker、Git service、agent runtime の capacity は各 host product docs
が所有します。

## Current Traffic Baseline

2026-06-07 時点で hosted Takosumi は pre-GA。customer production traffic
baseline は 0 customer RPS。capacity planning は staging signal と launch
floor を使います。

| Surface                            | Current measured production traffic | Planning floor for launch | Notes                                                                                                                   |
| ---------------------------------- | ----------------------------------: | ------------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| Dashboard / account read traffic   |                      0 customer RPS |               50 RPS peak | platform worker Web/API                                                                                                 |
| Control-plane write traffic        |                      0 customer RPS |               10 RPS peak | Workspace / Project / Capsule / Source / ProviderConnection / ProviderBinding / Run writes                     |
| Source sync / compatibility checks |                 0 customer runs/min |          30 runs/min peak | git/provider-bound                                                                                                      |
| Plan runs                          |                0 customer plans/min |         30 plans/min peak | OpenTofu init/plan and policy-bound                                                                                     |
| Apply / destroy runs               |              0 customer applies/min |       10 applies/min peak | provider RPC-bound                                                                                                      |
| Runner queue depth                 |                   0 customer queued |    500 queued / 50 active | Cloudflare Queue + runner container                                                                                     |
| Artifact / state writes            |               0 customer writes/min |       100 writes/min peak | R2 source/artifact/state/backup buckets                                                                                 |

launch floor は current traffic より高めに設定し、最初の hosted environment で
即時 resizing が不要な水準にします。

## One-year Forecast

予測 horizon: hosted launch から 12 か月。

前提:

- 月次 peak traffic 成長率: 15 %
- 上位 10 % の Space が Run traffic の 60 % を生成しうる
- apply / destroy は provider RPC と policy gate により plan より低く throttle する
- billing enforce 有効化後は credit reservation read/write が control-plane write に乗る

```text
forecast_peak = max(current_peak, launch_floor) * 1.15^12
required_capacity = forecast_peak * 2.0 headroom
```

## Sizing Baseline

| Component                       | Initial floor                      | Scale trigger                                | Headroom rule                                      |
| ------------------------------- | ---------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Takosumi platform worker        | Cloudflare-managed Worker capacity | p95 latency > target for 30 min or 5xx > 1 % | isolate slow runner dispatch from request handling |
| Queue consumer                  | 2 logical consumers / env          | queue age above target or DLQ growth         | keep one consumer failure domain spare             |
| Runner container pool           | 50 active launch cap               | active runs > 60 % of cap for 15 min         | throttle apply below provider limits               |
| CoordinationObject              | per-Installation lease namespace   | lease takeover or alarm lag                  | no single DO hot spot for all Spaces               |
| D1 control ledger               | managed D1 tier                    | lock wait / storage threshold                | 90 days storage runway                             |
| R2 source/artifact/state/backup | provider managed                   | growth > forecast for 7 days                 | lifecycle policy reviewed monthly                  |

planning に使う conservative capacity:

| Surface                            | Safe capacity used for planning |
| ---------------------------------- | ------------------------------: |
| control-plane read API             |           500 RPS / environment |
| control-plane writes               |           100 RPS / environment |
| source sync / compatibility checks |                  30 active runs |
| plan runs                          |                  30 active runs |
| apply / destroy runs               |                  10 active runs |
| R2 artifact/state writes           |                  100 writes/min |

## Headroom Checks

capacity review で見る signal:

- platform worker 5xx / latency
- `/api/v1` read/write RPS
- Provider Catalog read RPS and Provider Connection create/update/rotate write rate
- source sync / compatibility / plan / apply run counts
- queue depth, queue age, DLQ count
- CoordinationObject lease waits and takeover count
- runner container startup latency and failure rate
- D1 CPU, lock wait, storage growth
- R2 object count / byte growth per bucket
- Space-level top-N usage concentration

Release blocker しきい値:

- platform worker API p95 above SLO for 30 min
- queue age above SLO with no throttle plan
- runner active cap forecast below 1.5x design peak
- DB / object storage runway under 30 days
- one Space can consume more than 50 % of regional runner capacity without quota guard

## Review Cadence

- pre-GA 期間および GA 後 30 日間は週次
- traffic が安定したら月次
- SEV-1 / SEV-2 incident の直後
- billing enforce 有効化前
- 新 provider target / runner image 有効化前
- pricing / quota 変更前

各 review でこのページを更新するか、baseline が引き続き有効である理由を
private run log に記録します。

## Update Rule

hosted production telemetry が揃った時点で、pre-GA の current traffic 行を
30 日間 p95 peak 実測値に置き換えます。単日の spike を baseline として
採用してはいけません。
