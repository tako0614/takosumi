# Exposure and Activation Model

> このページでわかること: exposure と activation のモデル定義。

route を持つ resource は 1 つの Space の中に Exposure intent を作成する。public
manifest では、これは `custom-domain@v1` や `web-service@v1` の route フィールド
などの Shape resource で表現され、別の top-level `expose` object で表現しない。
Exposure は Link ではない。

## Exposure

```yaml
resources:
  - shape: custom-domain@v1
    name: web
    provider: "@takos/cloudflare-dns"
    spec:
      name: app.example.com
      target: ${ref:api.url}
```

resolver はこれを `api` resource output を target にした `app.example.com` の
Exposure record に変換する。Exposure は外部 ingress を準備するが、それだけで
deployment を current にはしない。

## Apply vs activation

```text
apply:
  prepare objects, links, generated grants, generated credentials, exposure material

activate:
  update traffic assignment, activation snapshot, and Space-local GroupHead

post-activate observe:
  verify route health and active assignment
```

## Space rule

Exposure 所有権、ingress 予約、route の materialization、ActivationSnapshot、
GroupHead は Space-local である。operator の route policy が shared ownership や
delegation を許可しない限り、2 つの Space が同じ global ingress を主張する
ことはできない。

```text
GroupHead identity = spaceId + groupId
```

Space を跨ぐ traffic assignment は public v1 の一部ではない。

## Exposure generated objects

Exposure の materialization は generated object を作成しうる。

```text
IngressReservation
DnsMaterialization
TlsMaterialization
ProviderIngressObject
TrafficAssignment
```

各 generated object は owner、reason、決定的 id、delete policy を持つ。

```yaml
GeneratedObject:
  owner: exposure:web
  reason: tls-materialization
  deletePolicy: delete-with-owner | retain-with-approval
```

## ActivationSnapshot

```yaml
ActivationSnapshot:
  id: activation:...
  desiredSnapshotId: desired:...
  assignments: []
  activatedAt: ...
  health: pending | healthy | degraded | failed
  sourceObservationDigest: sha256:... # latest observation feeding `health`
```

`sourceObservationDigest` は現在の `health` 注記を生成した ObservationSet entry
を記録する。これは runtime reality を snapshot に結びつける唯一の authoritative
な link である。ObservationSet entry は `assignments` を変更しない。

GroupHead は apply phase の再検証と activation policy の通過後にのみ動く。

## Post-activate health state

activation 後、exposure は closed v1 state machine を通じて runtime reality を
追跡する。状態遷移は
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
の `observe` stage が ObservationSet に append する entry
によってのみ駆動される。 どの状態遷移も DesiredSnapshot を変更しない。

```text
unknown → observing → healthy
                 \ → degraded
                 \ → unhealthy

healthy   ↔ degraded ↔ unhealthy   (re-entry on observation change)
```

| state       | meaning                                               |
| ----------- | ----------------------------------------------------- |
| `unknown`   | no observation recorded yet (pre-first-probe)         |
| `observing` | a probe is in flight                                  |
| `healthy`   | latest observation confirms the desired assignment    |
| `degraded`  | partial signal; some checks pass, some fail           |
| `unhealthy` | latest observation contradicts the desired assignment |

`unhealthy` の effect:

- `unhealthy` は DesiredSnapshot を書き換えない。DriftIndex と
  ActivationSnapshot 上の注記に流れるだけ。
- `unhealthy` は将来の activation が開始する新規 traffic shift を block する
  (approval で明示的に override されない限り)。既存の GroupHead pointer は
  自動的には rollback されない (fail-safe-not-fail-closed)。
- この state から drift entry がどう作られるかは
  [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
  を参照。
