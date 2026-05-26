# HTTP 公開 {#http-exposure}

public app endpoint は通常の component 接続として表現します。workload は callable HTTP の出力データを `publish` し、operator が official `gateway` の kind の定義、または同等の ingress の kind の定義を採用している場合、その ingress component が出力データを `listen` して gateway の `spec.listeners` / `spec.routes` に接続します。`listeners` と `routes` は `gateway` の kind の定義に従う `spec` schema です。listener、TLS、host、route のどの機能を使えるかは operator / backend capability が決めます。operator のバリデーションは、未対応の listener、host、TLS、route を実体化の前に拒否します。

この例は operator profile が `worker` と `gateway` の省略名を採用済みの kind の定義 URI に対応付けている前提です。

```yaml
apiVersion: v1
metadata:
  id: com.example.web
  name: Example Web
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

`web.http` は workload が公開する upstream の出力データで、通常 `targets[]` を持ちます。`public.public` は gateway / ingress component が公開する public endpoint の出力データで、通常 `endpoints[]` を持ちます。どちらも `http-endpoint` という出力の形式ですが、publisher の役割が違います。 `public.public` は Deployment output と Deployment の記録から参照できます。 `routes[].to` は `listen` binding key を指します。この例では binding key は `app`、注入モードは `upstream` です。実体化された `endpoints[]` の `primary` marker は portable catalog output です。operator profile はこの marker を launch surface や dashboard surface で使えます。

## Portable route の意味 {#portable-route-semantics}

portable route semantics の規定本文は [Takosumi Kind カタログ仕様](./type-catalog.md#gateway-portable-subset) にあります。このページでは `gateway` を採用済み ingress の kind 定義の例として使います。

gateway の publish の出力の Deployment output は non-secret `http-endpoint` の出力データです。portable output は `endpoints[]` です。各 endpoint は `url`、 `scheme`、`host`、`listener`、`visibility`、`primary`、任意の `routes[]` (`pathPrefix`, `to`) を記録します。複数の public endpoint を実体化する場合、 primary は 1 つだけです。operator のバリデーションは未対応の listener、TLS policy、host、path prefix を実体化の前に拒否します。

## Request path の分離 {#request-path}

install / deploy と runtime request は別の plane です。

```text
install / deploy:
  manifest -> Installer API -> Deployment outputs / retained evidence
          -> selected backend/operator binding

runtime request:
  client -> backend-native listener/route -> active workload
         <- same backend data plane <- response
```

Takosumi core は deploy 時に manifest、publish/listen resolution、Deployment outputs を記録し、Deployment の記録を残します。選択された backend / operator binding がその記録から backend-native ingress config を実体化し、runtime HTTP request は backend-native listener / route が active workload に届けます。operator distribution が router を Takosumi と同じ host に同居させる場合も、その router は runtime ingress role です。

runtime traffic の authority は `Installation.currentDeploymentId` が指す `succeeded` Deployment と、その Deployment の記録に含まれる ingress 情報です。 `running` / `failed` Deployment は HTTP traffic authority になりません。 rollback は current pointer を過去の `succeeded` Deployment に戻し、その Deployment の public/non-secret outputs と reactivation の記録を再利用します。

## Domain policy {#domain-policy}

`spec.listeners.<name>.host` は gateway の kind の定義に従う ingress input です。host を省略した場合の意味は、採用した kind の定義と operator policy が定義します。operator が default public host を割り当てた場合、その URL は materialized public endpoint output に反映できます。明示 host の reservation、custom-domain proof、DNS ownership proof、TLS provisioning は採用した kind の定義、operator policy、backend-specific flow が扱います。manifest は backend object ID、DNS verification record、TLS certificate handle、generated object ref を直接書きません。

## 関連ページ {#related-pages}

- [manifest](./manifest.md)
- [Takosumi Kind カタログ仕様](./type-catalog.md)
