# Kind Descriptor Examples {#kind-registry}

`components.<name>.kind` は operator distribution が解決する component type
です。AppSpec は kind string と kind-specific `spec` を運び、runtime behavior は
operator が選ぶ implementation が持ちます。

このページは `https://takosumi.com/kinds/v1/*` で公開される takosumi.com の
reference descriptor examples です。operator は必要な descriptor example を
alias map と implementation set に取り込みます。

## Descriptor examples

takosumi.com reference descriptor examples が扱う common kind examples は次の 5
つです。これは Takosumi built-ins の一覧ではなく、operator が opt-in できる
descriptor examples です。

| Kind           | 用途                           | 代表 publication                  |
| -------------- | ------------------------------ | --------------------------------- |
| `worker`       | JS worker / serverless runtime | `http` as `http-endpoint`         |
| `web-service`  | OCI container HTTP service     | `http` as `http-endpoint`         |
| `postgres`     | PostgreSQL database            | `connection` as `service-binding` |
| `object-store` | S3-compatible bucket           | `bucket` as `object-store`        |
| `gateway`      | listener / TLS / route rule    | `public` as `http-endpoint`       |

operator が alias map に opt-in している場合、AppSpec author は `worker`
のような short alias を使えます。operator はその alias を
`https://takosumi.com/kinds/v1/worker` に解決し、対応する implementation を選び
ます。完全 URI を直接書くこともできます。

operator-defined kind は任意 domain の kind URI と implementation を operator が
用意します。

以下の YAML 例で使う `worker` / `web-service` / `postgres` / `object-store` /
`gateway` は、operator が takosumi.com reference alias map に opt-in している
前提の short alias です。URI を直接書けば、その alias map に依存しません。

## Material contracts

`publish.<name>.as` は publication の material contract を選びます。代表的な
contract は次の通りです。

| Contract          | 用途                                     |
| ----------------- | ---------------------------------------- |
| `http-endpoint`   | HTTP(S) callable endpoint                |
| `service-binding` | DB / external API の connection material |
| `object-store`    | bucket endpoint と credential refs       |
| `event-channel`   | topic / queue / stream                   |

contract alias の正確な schema は kind descriptor / operator distribution
が公開します。AppSpec author は publication 名と `as` を見れば、どの component
publication をどの binding として使うかを読めます。provider output field から
material field への写像は kind descriptor / operator implementation binding 側の
責務です。

## `worker`

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
    publish:
      http:
        as: http-endpoint
```

`worker` の input は resolved source snapshot 内の `entrypoint` path です。
source 側の build service / CI が bundle を作る場合、その結果を prepared source
snapshot 内の file として置きます。

```yaml
spec:
  entrypoint: dist/worker.mjs
  compatibilityDate: "2025-01-01" # optional provider extension
```

provider-specific routing は `worker.spec` ではなく、`gateway` などの edge
component で表現します。worker は callable endpoint を `web.http` として publish
するだけです。

## `web-service`

```yaml
components:
  api:
    kind: web-service
    spec:
      image: ghcr.io/example/api:latest
      port: 8080
      scale:
        min: 0
        max: 3
    publish:
      http:
        as: http-endpoint
```

`web-service` は Fargate / Cloud Run / Kubernetes / Docker Compose / systemd
などの container runtime 向けの kind URI を使います。

## `postgres`

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
```

consumer は `from: db.connection` で connection material を listen し、env /
mount などで受け取ります。

## `object-store`

```yaml
components:
  assets:
    kind: object-store
    spec:
      name: app-assets
      versioning: true
    publish:
      bucket:
        as: object-store
```

provider は S3 / R2 / GCS / MinIO / filesystem などに materialize できます。

## `gateway`

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
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

`gateway` は listen した upstream material を public listener / route rule
に接続し、materialized public endpoint を `public` publication として publish
します。DNS、certificate、redirect、rewrite、weighted routing などは gateway
kind の `spec` と provider extension です。

## JSON-LD descriptor metadata

JSON-LD descriptor は kind identity、input schema、publication / listen
contract、outputs を定義する metadata です。runtime behavior は operator
distribution が kind URI に bind する implementation が持ちます。

Takosumi reference kernel では、その binding を `KernelPlugin.provides[]` で表し
ます。これは reference implementation の表現であり、JSON-LD descriptor 自体は
runtime plugin mechanism ではありません。

```json
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://operator.example.com/kinds/cache",
  "name": "cache",
  "spec": {
    "type": "object",
    "properties": {
      "engine": { "enum": ["redis", "valkey"] }
    }
  },
  "publications": {
    "endpoint": {
      "contract": "http-endpoint",
      "material": { "url": "$outputs.endpoint" }
    }
  },
  "outputs": [
    { "name": "endpoint", "type": "string" }
  ]
}
```

## Source files and DataAssets

source tree の file を読む kind は、resolved source snapshot 内の path を
kind-specific `spec` に置きます。Reference worker kind は `spec.entrypoint` を
source-root-relative path として読みます。

DataAsset は operator が有効化できる optional extension です。prepared source の
代わりに AppSpec へ generic artifact kind / hash を書く仕組みではありません。
reference connector set が認識する DataAsset metadata examples は次の通りです:

- `oci-image`
- `js-bundle`
- `lambda-zip`
- `static-bundle`
- `wasm`

参照先: [DataAsset Policy](./data-asset-policy.md) と
[DataAsset GC](./artifact-gc.md)。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Provider Implementations](./providers.md)
- [Connector Guide](./connector-contract.md)
- [Extending Takosumi](../extending.md)
