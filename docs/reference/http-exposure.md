# Runtime HTTP Exposure {#http-exposure}

public app endpoint は通常の component connection として表現します。workload は
callable HTTP material を `publish` し、operator が official `gateway`
descriptor または同等の ingress descriptor を採用している場合、その ingress
component が material を `listen` して listener / route intent に接続します。
`listeners` と `routes` は `gateway` descriptor-owned `spec` schema です。
Operator/provider capability decides which listener, TLS, host, and route
features are supported. Operator validation rejects unsupported listener, host,
TLS, or route features before materialization.

The example assumes an operator profile maps `worker` and `gateway` short
aliases to adopted descriptor URIs.

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

`web.http` は upstream material です。`public.public` は materialized public
endpoint の publication で、Deployment output と retained
implementation/operator evidence から参照できます。 `routes[].to` は `listen`
binding key を指します。この例では binding key は `app`、projection family は
`upstream` です。Account-plane launch surfaces use the primary endpoint from the
materialized `endpoints[]` output.

## Portable Route Semantics {#portable-route-semantics}

The normative portable route semantics live in the
[Takosumi Official Type Catalog Specification](./type-catalog.md#gateway-portable-subset).
This page uses `gateway` only as an adopted ingress descriptor example.

Deployment output for a gateway publication is non-secret `http-endpoint`
material. The portable output is `endpoints[]`; each endpoint records `url`,
`scheme`, `host`, `listener`, `visibility`, `primary`, and optional `routes[]`
(`pathPrefix`, `to`). Exactly one endpoint is primary when multiple public
endpoints are materialized. Operator validation rejects unsupported listener,
TLS policy, host, or path prefix before materialization.

## Request path {#request-path}

install / deploy と runtime request は別の plane です。

```text
install / deploy:
  AppSpec -> Installer API -> Deployment outputs / retained evidence
          -> selected provider/operator binding

runtime request:
  client -> provider-native listener/route -> active workload
         <- same provider data plane <- response
```

Takosumi core は deploy 時に AppSpec、publish/listen resolution、Deployment
outputs を記録し、retained implementation/operator evidence を Deployment に紐づ
けます。選択された provider / operator binding がその evidence から
provider-native ingress config を materialize し、runtime HTTP request は
provider-native listener / route が active workload に届けます。operator
distribution が router を kernel と同じ host に同居させる場合も、その router は
runtime ingress role です。

## Domain policy {#domain-policy}

`spec.listeners.<name>.host` は desired ingress intent です。host を省略した場合
の意味は、採用した descriptor と operator policy が定義します。operator が
default public host を割り当てた場合、その URL は materialized public endpoint
output に反映できます。明示 host がある場合、operator は domain policy、
reservation conflict、custom domain の DNS / ownership proof を account-plane /
provider flow で確認してから materialize します。AppSpec は provider object ID、
DNS verification record、TLS certificate handle、generated object ref を直接書き
ません。

## Related pages {#related-pages}

- [AppSpec](./app-spec.md)
- [Takosumi Official Type Catalog Specification](./type-catalog.md)
- [Runtime Routing](./architecture/runtime-routing.md)
