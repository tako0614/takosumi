# Reference Kind Descriptors {#kind-registry}

`components.<name>.kind` は operator distribution が解決する component type
です。JSON-LD descriptor が kind の型・意味・入出力を与え、operator の
implementation binding が runtime behavior を与えます。Takosumi reference kernel
では implementation binding を reference provider adapter として attach します。

このページは `https://takosumi.com/kinds/v1/*` で公開される **reference
descriptor examples** の説明です。operator は必要な descriptor を alias map と
plugin set に取り込みます。

## Reference component kinds

takosumi.com reference descriptors が扱う common kind examples は次の 5 つです。

| Kind            | 用途                           | 代表 outputs                                   |
| --------------- | ------------------------------ | ---------------------------------------------- |
| `worker`        | JS worker / serverless runtime | `url`, `id`, `version`                         |
| `web-service`   | OCI container HTTP service     | `url`, `internalHost`, `internalPort`          |
| `postgres`      | PostgreSQL database            | `host`, `port`, `database`, `connectionString` |
| `object-store`  | S3-compatible bucket           | `bucket`, `endpoint`, `region`                 |
| `custom-domain` | DNS record + TLS termination   | `fqdn`, `certificateId`, `nameservers`         |

AppSpec author は `worker` のような short alias を使えます。operator は `worker`
を `https://takosumi.com/kinds/v1/worker` に解決し、対応する provider
implementation を選びます。完全 URI を直接書くこともできます。

operator-defined kind は任意 domain の JSON-LD descriptor と materializer を
operator が用意します。

## `worker`

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
      compatibilityDate: "2025-01-01"
```

`worker` の provider input は prepared source snapshot 内の `entrypoint` path
です。source 側の build service / CI が bundle を作る場合、その結果を prepared
source の file として置きます。DataAsset metadata や hash は DataAsset workflow
側で扱います。

```yaml
spec:
  entrypoint: dist/worker.mjs
  compatibilityDate: "2025-01-01"
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

## JSON-LD descriptor

operator-defined kind は JSON-LD descriptor で `spec`、`publishes`、`listens`、
`outputs` を宣言できます。operator は descriptor の kind URI に対して
implementation binding を用意し、AppSpec component に runtime behavior
を与えます。 Takosumi reference implementation では、その binding を
`KernelPlugin.provides[]` で表します。

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

## Data Assets

`/v1/artifacts` は operator が data blob を保管するための DataAsset API です。
そこに付く `kind` は operator / connector distribution が定義する metadata
です。

operator は必要に応じて `registerArtifactKind` で discovery metadata と size cap
を登録できます。connector は `acceptedArtifactKinds` で consume できる metadata
value を宣言します。runtime が source tree の file を読む場合は DataAsset
metadata ではなく prepared source snapshot と kind-specific `spec` を使います。

Reference worker kind は data asset API を使わず、prepared source の
`spec.entrypoint` を読みます。詳細は [DataAsset Policy](./data-asset-policy.md)
と [DataAsset GC](./artifact-gc.md) を参照してください。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Provider Implementations](./providers.md)
- [Connector Contract](./connector-contract.md)
- [Extending Takosumi](../extending.md)
