# Runtime routing {#runtime-routing}

このページは reference architecture の internal routing model です。manifest author に見える public surface は gateway / ingress component の `kind` / `spec` / `connect`、任意の root `publish`、Deployment output です。`RoutingPointer` や `TrafficSnapshot` は operator-selected routing state を記録する internal evidence です。

Runtime routing は、Deployment に紐づく retained activation evidence と implementation/operator evidence を backend-native data plane に反映する model です。hostname / path / resource output が active workload に届くようにします。

Takosumi control plane は install / deploy / rollback を扱います。runtime request は backend-native data plane が処理します。

## 入力 {#inputs}

routing materialization が参照する入力は、apply 済み Deployment に紐づく deploy record です。

- selected runtime execution binding
- resolved source identity and backend-specific immutable runtime input digests
- materialized env / secret refs
- resource output refs
- exposure / traffic assignment
- runtime network policy

manifest author は runtime routing を root field として操作しません。worker や web-service は `http` output を持ち、`gateway` のような edge component がそれを `connect` して public listener / route rule に接続します。

operator-selected execution はその intent を以下のような形で反映します:

- Cloudflare route
- Kubernetes Gateway / HTTPRoute
- Caddy / Nginx config
- load balancer rule / edge runtime binding

gateway が作った public endpoint は Deployment output / launch / account layer projection から参照できます。他の Installation や operator workflow に投影したい場合は root `publish` で `public.public` のような output を Installation output service path declaration として path に対応付けます。

通常の component-to-component routing は public ingress ではなく resolved 出力データ / backend-native private routing を使います。

HTTP output の material kind は callable HTTP 出力データを表します。upstream か public endpoint かは component role と selected materialization evidence で決まります。

manifest core に別 field は増やしません。gateway kind の定義 / operator policy が upstream binding と public endpoint output を区別します。

## HTTP endpoint {#http-endpoint}

`worker` は resolved source view と `spec.entrypoint` を request-driven runtime に渡す workload です。container runtime は official catalog または operator が採用した kind の定義が定める `web-service` を使い、その kind の定義の schema に従って `spec.image` を読みます。

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

  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
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
publish:
  public-endpoint:
    output: public.public
    kind: http-endpoint
    path: acme.edge.public
```

この root `publish` は public endpoint を Installation output service path declaration として Deployment output に記録する任意の宣言です。discoverable にするかどうかは operator / product distribution の projection policy で決まり、browser ingress の reachability は gateway component の `spec` だけで決まります。

backend は Cloudflare Workers や Deno Deploy など任意ですが、canonical routing authority は retained activation evidence です。`host` は gateway の kind の定義が持つ ingress input であり、reservation、custom-domain proof、DNS ownership proof、TLS provisioning は採用済みの kind の定義、operator policy、backend-specific flow が扱います。

```text
install / deploy:
  manifest -> Takosumi -> retained evidence / RoutingPointer
          -> selected backend/operator binding

runtime request:
  client -> backend-native listener/route -> active workload
         <- same backend data plane <- response
```

HTTP workload の runtime data plane は `client -> backend listener/route -> worker/web-service -> response` です。Takosumi は deploy 時に manifest と public/non-secret Deployment outputs を記録する control plane です。選択された backend/operator binding は Deployment に紐づく retained evidence から ingress config を materialize します。

## Component 間接続 {#component-connection}

resource 間の依存は manifest の `connect` / `listen` で表現します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small

  edge:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      database:
        output: db.connection
        inject: secret-env
        prefix: DATABASE
```

connect / listen で受け取った出力データは secret-env、env、mount、upstream、config など kind-specific な形で workload に渡されます。

## Data plane dispatch {#dispatch}

runtime request は RoutingPointer が指す TrafficSnapshot assignments を反映した data plane で処理されます。その data plane は backend-native route、load balancer、reverse proxy、edge runtime binding などです。Takosumi API process は per-request path に入りません。

- Takosumi API hostname は installer / internal API へ向ける。
- manifest の gateway component から作られた public listener は selected backend の data plane で runtime workload へ向ける。
- external identity endpoint など operator-owned surface は platform service と operator 側 routing で扱う。
- operator の設定が router を Takosumi と同じ process / host に同居させる場合も、その router は runtime ingress role です。

Deployment に紐づく retained evidence は backend-native data plane を materialize する入力です。public な Installer authority は Installation の `currentDeploymentId` です。

reference routing implementation は `RoutingPointer.currentTrafficSnapshotId -> TrafficSnapshot.assignments` のような retained evidence から traffic state を導出できます。これらの record は implementation evidence であり、追加の public core entity ではありません。

data plane は backend-specific route cache を持てます。cache は selected runtime routing evidence から更新されます。

## Rollback {#rollback}

rollback は Installation の `currentDeploymentId` を retained Deployment へ戻す操作です。根拠は過去 Deployment の recorded source と deploy record / resource metadata です。

reference routing implementation は必要に応じて RoutingPointer / traffic assignment evidence を再有効化できます。historical Deployment record は書き換えず、新しい Deployment も作りません。

durable resource contents の巻き戻しは rollback ではなく、別の source apply / resource operation として扱います。

## Backend parity {#backend-parity}

Takosumi は backend-neutral な runtime contract を提供します。同じ manifest でも、Cloudflare Workers、Kubernetes、bare metal、自前 runtime では backend capability と実行時制約が異なります。差分は backend capability と deploy record に記録し、manifest contract 自体には混ぜません。
