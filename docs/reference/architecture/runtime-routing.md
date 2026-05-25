# Runtime routing {#runtime-routing}

このページは reference architecture の internal routing model です。AppSpec
author に見える public surface は gateway / ingress component の `kind` / `spec`
/ `publish` / `listen` と Deployment output です。`GroupHead` や
`ActivationSnapshot` は operator-selected routing state を記録する internal
evidence です。

Runtime routing は、Deployment に紐づく retained activation evidence と
implementation/operator evidence を provider-native data plane
に反映し、hostname / path / resource output が active workload に届くようにする
model です。 account、billing、OIDC issuer、 customer onboarding は operator
account plane に置きます。Takosumi kernel control plane は install / deploy /
rollback を扱い、runtime request は provider-native data plane が処理します。

## 入力 {#inputs}

routing materialization が参照する入力は、apply 済み Deployment に紐づく
retained implementation/operator evidence です。

- selected runtime execution binding
- resolved source identity and provider-specific immutable runtime input digests
- materialized env / secret refs
- resource output refs
- exposure / traffic assignment
- runtime network policy

AppSpec author は runtime routing を root field として操作しません。worker や
web-service は `http-endpoint` material を publish し、`gateway` のような edge
component がそれを `listen` して public listener / route rule に接続します。
operator-selected execution はその intent を Cloudflare route、Kubernetes
Gateway / HTTPRoute、Caddy / Nginx config、load balancer rule、edge runtime
binding などへ反映します。gateway が作った public endpoint は gateway 自身の
publication として Deployment output / launch / account-plane projection
から参照できます。別 component が public endpoint を listen できるかは operator
policy と kind descriptor が決めます。通常の component-to-component routing は
public ingress ではなく resolved material / provider-native private routing
を使います。

`http-endpoint` の contract identity は callable HTTP material
を表します。upstream か public endpoint かは publisher role と selected
materialization evidence で決まります。AppSpec core に別 field
を増やさず、descriptor / operator policy が `upstream` projection に使える
publication と、Deployment output / launch / account-plane projection 用の
public publication を区別します。

## HTTP endpoint {#http-endpoint}

`worker` は resolved source snapshot と `spec.entrypoint` を request-driven
runtime に渡す workload です。container runtime は official catalog または
operator-adopted descriptor が定義する `web-service` を使い、その descriptor
schema に従って `spec.image` を読みます。

```yaml
apiVersion: v1
metadata:
  id: com.example.edge
  name: Edge App
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
          host: web.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

provider は Cloudflare Workers や Deno Deploy など任意ですが、canonical routing
authority は retained activation evidence です。 `host` は desired ingress
intent であり、operator は domain policy、reservation conflict、custom domain の
DNS / ownership proof を account-plane / provider flow で確認してから
作成します。

```text
install / deploy:
  AppSpec -> Takosumi kernel -> retained evidence / GroupHead
          -> selected provider/operator binding

runtime request:
  client -> provider-native listener/route -> active workload
         <- same provider data plane <- response
```

HTTP workload の runtime data plane は
`client -> provider listener/route -> worker/web-service -> response` です。
Takosumi kernel は deploy 時に AppSpec と public/non-secret Deployment outputs
を記録する control plane です。選択された provider/operator binding は
Deployment に紐づく retained evidence から ingress config を materialize
します。

## Component 間接続 {#component-connection}

resource 間の依存は AppSpec の `publish` / `listen` で表現します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  edge:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      database:
        from: db.connection
        as: secret-env
        prefix: DATABASE
```

listen で受け取った material は secret-env、env、mount、upstream、config など
kind-specific な形で workload に渡されます。

## Data plane dispatch {#dispatch}

runtime request は GroupHead が指す ActivationSnapshot assignments を反映した
data plane で処理されます。その data plane は provider-native route、load
balancer、reverse proxy、edge runtime binding などです。Takosumi kernel API
process は per-request path に入りません。

- kernel API hostname は installer / internal API へ向ける。
- AppSpec の gateway component から作られた public listener は selected provider
  の data plane で runtime workload へ向ける。
- external identity endpoint など operator-owned surface は external publication
  と operator 側 routing で扱う。
- operator distribution が router を kernel と同じ process / host に同居させる
  場合も、その router は provider ingress role です。

Deployment に紐づく retained evidence は provider-native data plane を
materialize する入力です。Public Installer authority は Installation の
`currentDeploymentId` です。reference routing implementation can derive traffic
state from retained evidence such as
`GroupHead.currentActivationSnapshotId -> ActivationSnapshot.assignments`; those
records are implementation evidence, not additional public core entities. data
plane は provider-specific route cache を持ってよいですが、cache は selected
runtime routing evidence から更新されます。

## Rollback {#rollback}

rollback は過去 Deployment の recorded source と、その Deployment に紐づく
retained implementation/operator evidence / resource metadata を根拠に、
Installation の `currentDeploymentId` を retained Deployment へ戻す操作です。
reference routing implementation は必要に応じて GroupHead / traffic assignment
evidence を再有効化できます。historical Deployment record は書き換えず、新しい
Deployment も作りません。durable resource contents の巻き戻しは rollback
ではなく、新しい
Deployment / resource operation として扱います。

## Backend parity {#backend-parity}

Takosumi kernel は backend-neutral な runtime contract を提供します。同じ
AppSpec でも、Cloudflare Workers、Kubernetes、bare metal、自前 runtime では
provider capability と実行時制約が異なります。差分は provider capability と
retained implementation/operator evidence に記録し、AppSpec contract 自体には
混ぜません。
