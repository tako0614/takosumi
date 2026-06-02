# Runtime routing {#runtime-routing}

このページは reference architecture の internal routing model です。Takosumi v1 の public Source authoring は manifestless です。`RoutingPointer` や `TrafficSnapshot` は operator-selected routing state を記録する internal evidence であり、public Takosumi v1 entity ではありません。

Runtime routing は、Deployment に紐づく retained activation evidence と implementation/operator evidence を backend-native data plane に反映する model です。hostname / path / resource output が active workload に届くようにします。

Takosumi control plane は install / deploy / rollback を扱います。runtime request は backend-native data plane が処理します。

## 入力 {#inputs}

routing materialization が参照する入力は、apply 済み Deployment に紐づく deploy record です。

- selected runtime execution binding
- resolved Source identity and backend-specific immutable runtime input digests
- materialized env / secret refs
- resource output refs
- exposure / traffic assignment
- runtime network policy

Source author は runtime routing を Takosumi 専用 root field として操作しません。Public ingress intent は operator PlatformService inventory、account-plane UI / API、BindingSelection、または operator route policy から決まります。

operator-selected execution はその intent を以下のような形で反映します:

- Cloudflare route
- Kubernetes Gateway / HTTPRoute
- Caddy / Nginx config
- load balancer rule / edge runtime binding

gateway / public endpoint は Deployment output / launch / account layer projection から参照できます。discoverable にするかどうかは operator / product distribution の projection policy で決まり、browser ingress の reachability は selected backend data plane で決まります。

HTTP output の material kind は callable HTTP 出力データを表します。upstream か public endpoint かは selected materialization evidence で決まります。

```text
install / deploy:
  Source + BindingSelection -> Takosumi -> retained evidence / RoutingPointer
                              -> selected backend/operator binding

runtime request:
  client -> backend-native listener/route -> active workload
         <- same backend data plane <- response
```

HTTP workload の runtime data plane は `client -> backend listener/route -> worker/web-service -> response` です。Takosumi は deploy 時に Source と public/non-secret Deployment outputs を記録する control plane です。選択された backend/operator binding は Deployment に紐づく retained evidence から ingress config を materialize します。

## Runtime dependency routing {#runtime-dependency-routing}

resource 間の依存は operator PlatformService inventory と binding selection で表現します。

```json
{
  "bindingsSnapshot": {
    "database": {
      "serviceId": "svc_postgres_primary",
      "access": "read-write",
      "projection": "secret-env"
    }
  }
}
```

解決済み出力データは secret-env、env、mount、upstream、config など adapter-specific な形で workload に渡されます。

## Data plane dispatch {#dispatch}

runtime request は RoutingPointer が指す TrafficSnapshot assignments を反映した data plane で処理されます。その data plane は backend-native route、load balancer、reverse proxy、edge runtime binding などです。Takosumi API process は per-request path に入りません。

- Takosumi API hostname は installer / internal API へ向ける。
- public listener は selected backend の data plane で runtime workload へ向ける。
- external identity endpoint など operator-owned surface は PlatformService と operator 側 routing で扱う。
- operator の設定が router を Takosumi と同じ process / host に同居させる場合も、その router は runtime ingress role です。

Deployment に紐づく retained evidence は backend-native data plane を materialize する入力です。public な Installer authority は Installation の `currentDeploymentId` です。

reference routing implementation は `RoutingPointer.currentTrafficSnapshotId -> TrafficSnapshot.assignments` のような retained evidence から traffic state を導出できます。これらの record は implementation evidence であり、追加の public Takosumi v1 entity ではありません。

data plane は backend-specific route cache を持てます。cache は selected runtime routing evidence から更新されます。

## Rollback {#rollback}

rollback は Installation の `currentDeploymentId` を retained Deployment へ戻す操作です。根拠は過去 Deployment の recorded Source と deploy record / resource metadata です。

reference routing implementation は必要に応じて RoutingPointer / traffic assignment evidence を再有効化できます。historical Deployment record は書き換えず、新しい Deployment も作りません。

durable resource contents の巻き戻しは rollback ではなく、別の source apply / resource operation として扱います。

## Backend parity {#backend-parity}

Takosumi は backend-neutral な runtime contract を提供します。同じ Source でも、Cloudflare Workers、Kubernetes、bare metal、自前 runtime では backend capability と実行時制約が異なります。差分は backend capability と deploy record に記録し、Source contract 自体には混ぜません。
