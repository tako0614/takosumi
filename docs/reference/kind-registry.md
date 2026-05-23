# Reference Kind Examples {#kind-registry}

`components.<name>.kind` は operator distribution が解決する component type
です。AppSpec は kind string と kind-specific `spec` を運び、operator の
implementation binding が runtime behavior を与えます。

このページは `https://takosumi.com/kinds/v1/*` で公開される takosumi.com
reference kind descriptor examples です。operator は必要な descriptor example を
alias map と implementation binding set に取り込みます。

## Reference component kinds

takosumi.com reference descriptor examples が扱う common kind examples は次の 5
つです。

| Kind            | 用途                           | 代表 outputs                                    |
| --------------- | ------------------------------ | ----------------------------------------------- |
| `worker`        | JS worker / serverless runtime | `url`, `id`, `version`                          |
| `web-service`   | OCI container HTTP service     | `url`, `internalHost`, `internalPort`           |
| `postgres`      | PostgreSQL database            | `host`, `port`, `database`, `passwordSecretRef` |
| `object-store`  | S3-compatible bucket           | `bucket`, `endpoint`, `region`                  |
| `custom-domain` | DNS record + TLS termination   | `fqdn`, `certificateId`, `nameservers`          |

operator が alias map に opt-in している場合、AppSpec author は `worker`
のような short alias を使えます。operator はその alias を
`https://takosumi.com/kinds/v1/worker` に解決し、対応する provider
implementation を選びます。完全 URI を直接書くこともできます。

operator-defined kind は任意 domain の kind URI と implementation binding を
operator が用意します。

## `worker`

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
```

`worker` の implementation input は prepared source snapshot 内の `entrypoint`
path です。source 側の build service / CI が bundle を作る場合、 その結果を
prepared source の file として置きます。

```yaml
spec:
  entrypoint: dist/worker.mjs
  compatibilityDate: "2025-01-01" # optional provider extension
```

provider-specific routing は `spec` の open extension として表現できます。

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
      - com.example.app.db
```

consumer は publish された namespace path を `listen` し、connection material を
env / mount / target などで受け取ります。

## `object-store`

```yaml
components:
  assets:
    kind: object-store
    spec:
      name: app-assets
      versioning: true
    publish:
      - com.example.app.assets
```

provider は S3 / R2 / GCS / MinIO / filesystem などに materialize できます。

## `custom-domain`

```yaml
components:
  domain:
    kind: custom-domain
    spec:
      name: app.example.com
    listen:
      com.example.app.web:
        as: target
```

target は `listen` した material の `url` から解決します。DNS、certificate、
redirect などは provider extension です。

## JSON-LD descriptor metadata

JSON-LD descriptor は kind identity、input schema、publish / listen contract、
outputs を定義します。runtime behavior は operator distribution が kind URI に
bind する implementation が持ちます。Takosumi reference kernel では、その
binding を `KernelPlugin.provides[]` で表します。

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
  "outputs": [
    { "name": "endpoint", "type": "string" }
  ]
}
```

## Source files and data assets

source tree の file を読む kind は、prepared source snapshot 内の path を
kind-specific `spec` に置きます。Reference worker kind は prepared source の
`spec.entrypoint` を読みます。

operator distribution が data blob upload / discovery を提供する場合は、AppSpec
とは別の DataAsset extension として扱います。参照先:
[DataAsset Policy](./data-asset-policy.md) と [DataAsset GC](./artifact-gc.md)。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Provider Implementations](./providers.md)
- [Connector Guide](./connector-contract.md)
- [Extending Takosumi](../extending.md)
