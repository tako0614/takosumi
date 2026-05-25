# イングレスルーティング {#exposure-activation-model}

Exposure は runtime routing の内部 record です。public manifest では `gateway`
のような component の `listen` と kind-specific `spec` として表現します。
Exposure は public ingress intent と activation state を記録し、runtime request
は provider-native data plane が処理します。

public ingress を持つ component は 1 つの Space の中に Exposure intent
を作成する。public manifest では、`gateway` のような component が upstream
publication を `listen` し、listener / route rule を `spec` に持つ形で表現しま
す。Exposure は Link と別の runtime object です。

## Exposure

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    publish:
      http:
        as: http-endpoint
  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          host: app.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

resolver はこれを `web.http` を `app` binding として listen する
`app.example.com` の Exposure record に変換する。`web.http` は upstream
の出力データ、`public.public` は materialized public endpoint の publish の出力
です。Exposure は外部 ingress を 準備するが、それだけで deployment を current
にはしない。selected provider implementation は Exposure から Cloudflare
route、Kubernetes Gateway / HTTPRoute、Caddy / Nginx config、load balancer
rule、edge runtime binding など の data plane object を作ります。

`host` は gateway の kind の定義が持つ ingress input です。reservation、
custom-domain proof、DNS ownership proof、TLS provisioning は採用済みの
kind の定義、operator policy、provider flow が扱います。manifest はその proof
protocol を埋め込まない。

```text
runtime request:
  client -> provider-native listener/route -> active workload
         <- same provider data plane <- response
```

## Installer API と activation {#installer-api-and-activation}

public operation は Installer API の install / deploy / rollback です。reference
Takosumi はその内側で resolve → apply → activate → observe の phase を進めます。
別の public activate endpoint は作りません。Installer API が
`Deployment.status: "succeeded"` を返す時点では、current Deployment として使う
ために必要な apply と activation の同期部分が完了しています。observe は後続で
provider-native data plane を確認し、health annotation を更新します。

```text
resolve:
  read source, parse manifest, resolve publish/listen, choose implementations

apply:
  prepare objects, links, generated authorization records, generated credentials, exposure material

activate:
  update traffic assignment, activation snapshot, and Space-local RoutingPointer

post-activate observe:
  verify route health and active assignment
```

Activation は traffic assignment / TrafficSnapshot / RoutingPointer を更新する内部
phase です。runtime request path は provider data plane のままです。

## Space ルール {#space-rule}

Exposure 所有権、ingress 予約、route execution、TrafficSnapshot、RoutingPointer は
Space-local である。operator の route policy が explicit delegation を許可しない
限り、2 つの Space が同じ global ingress を主張することはできない。

```text
RoutingPointer identity = spaceId + groupId
```

current v1 の traffic assignment は Space-local です。

## Exposure が生成する object {#exposure-generated-objects}

Exposure の materialization は generated object を作成しうる。

```text
IngressReservation
DnsMaterialization
TlsMaterialization
ProviderIngressObject
```

TrafficAssignment は Exposure materialization ではなく、TrafficSnapshot /
RoutingPointer 側が所有する activation state です。

各 generated object は owner、reason、決定的 id、delete policy を持つ。

```yaml
GeneratedObject:
  owner: exposure:public.public
  reason: tls-materialization
  deletePolicy: delete-with-owner | retain-with-approval
```

## TrafficSnapshot {#activationsnapshot}

```yaml
TrafficSnapshot:
  id: activation:...
  desiredSnapshotId: desired:...
  assignments: []
  activatedAt: ...
```

health は TrafficSnapshot の routing authority ではありません。ObservationState
と deploy record から作る非 authoritative projection
/ annotation として扱います。ObservationState entry は `assignments` を変更しませ
ん。

TrafficSnapshot の `assignments` が split / shadow を含む routing authority
です。RoutingPointer はその snapshot を Space-local current set として指します。
`currentDeploymentId` だけで canary / shadow 中の routing を復元してはいけませ
ん。

## Activate 後の health state {#post-activate-health-state}

activation 後、exposure は closed v1 persisted health enum を通じて runtime
reality を追跡する。`observing` は worker 内部の transient state で、persisted
health enum は `unknown | healthy | degraded | unhealthy` です。状態遷移は
[Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
の `observe` stage が ObservationState に append する entry
によってのみ駆動される。どの状態遷移も TargetState を変更しない。

observe は provider-native data plane を観測しますが、response path は担当しま
せん。

```text
unknown → healthy
       \ → degraded
       \ → unhealthy

healthy   ↔ degraded ↔ unhealthy   (re-entry on observation change)
```

| state       | meaning                                               |
| ----------- | ----------------------------------------------------- |
| `unknown`   | no observation recorded yet (pre-first-probe)         |
| `healthy`   | latest observation confirms the desired assignment    |
| `degraded`  | partial signal; some checks pass, some fail           |
| `unhealthy` | latest observation contradicts the desired assignment |

`unhealthy` の effect:

- `unhealthy` は TargetState を書き換えない。DriftIndex と
  TrafficSnapshot 上の注記に流れるだけ。
- `unhealthy` は将来の activation が開始する新規 traffic shift を block する
  (approval で明示的に override されない限り)。既存の RoutingPointer pointer は
  自動的には rollback されない (fail-safe-not-fail-closed)。
- この state から drift entry がどう作られるかは
  [Drift Detection](../drift-detection.md) を参照。

## クロスリファレンス {#cross-references}

- [Platform Service モデル](./platform-service-model.md)
- [Runtime Deployment モデル](./runtime-deployment-model.md)
- [Runtime Routing](./runtime-routing.md)
- [RoutingPointer rollout](../group-head-rollout.md)
