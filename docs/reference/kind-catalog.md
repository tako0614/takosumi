# Reference Kind Registry {#kind-catalog}

Takosumi AppSpec contract は公式 component kind を定義しません。
`components.<name>.kind` は opaque string で、意味は operator distribution が
attach する alias map、JSON-LD descriptor、provider plugin で決まります。

このページは Takos が `https://takosumi.com/kinds/v1/*` で公開する **reference
registry** の説明です。takosumi.com が publish していても、これらは Takosumi
spec の contract-owned kind ではありません。

## Reference component kinds

Takos reference distribution が扱う common kind は次の 5 つです。

| Kind            | 用途                           | 代表 outputs                                   |
| --------------- | ------------------------------ | ---------------------------------------------- |
| `worker`        | JS worker / serverless runtime | `url`, `id`, `version`                         |
| `web-service`   | OCI container HTTP service     | `url`, `internalHost`, `internalPort`          |
| `postgres`      | PostgreSQL database            | `host`, `port`, `database`, `connectionString` |
| `object-store`  | S3-compatible bucket           | `bucket`, `endpoint`, `region`                 |
| `custom-domain` | DNS record + TLS termination   | `fqdn`, `certificateId`, `nameservers`         |

AppSpec author は `worker` のような short alias を使えますが、alias は
operator-owned です。operator が `worker` を
`https://takosumi.com/kinds/v1/worker` に解決する設定を持たない場合、kernel は
provider operation 前に fail-closed します。完全 URI を直接書くこともできます。

operator-defined kind は任意 domain の JSON-LD descriptor と materializer を
operator が用意します。

## `worker`

```yaml
components:
  web:
    kind: worker
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
```

`worker` の provider input は uploaded `js-bundle` artifact descriptor です。
source 側の build service / CI は path を受け取っても構いませんが、provider
に渡る resolved bundle では次の形に変換済みである必要があります。

```yaml
spec:
  artifact:
    kind: js-bundle
    hash: sha256:...
  compatibilityDate: "2025-01-01"
```

`routes` は portable worker contract ではありません。必要な provider は `spec`
の open extension として独自に読めます。

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
などの container runtime 向けです。`worker` と同じ URI ではありません。

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
`outputs` を宣言できます。kernel は descriptor の意味を contract-owned
definition として持たず、 operator が attach した plugin が `provides[]`
で宣言する kind URI と AppSpec component を照合します。

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

## Artifact kinds

Artifact kind は uploaded / build-service-produced data asset の type
です。runtime-agent connector は受け付ける artifact kind を宣言し、mismatch を
apply 前に reject します。

Bundled artifact kinds:

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

| Artifact kind   | 用途                                  |
| --------------- | ------------------------------------- |
| `oci-image`     | OCI / Docker image reference          |
| `js-bundle`     | JavaScript / TypeScript worker bundle |
| `lambda-zip`    | AWS Lambda deployment zip             |
| `static-bundle` | static site tarball                   |
| `wasm`          | WebAssembly module                    |

詳細は [DataAsset Policy](./data-asset-policy.md) と
[Artifact GC](./artifact-gc.md) を参照してください。

## 関連ページ

- [AppSpec](./app-spec.md)
- [BuildSpec](./build-spec.md)
- [Provider plugin](./providers.md)
- [Connector Contract](./connector-contract.md)
- [Extending Takosumi](../extending.md)
