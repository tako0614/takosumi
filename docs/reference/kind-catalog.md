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
      entrypoint: dist/worker.mjs
      compatibilityDate: "2025-01-01"
```

`worker` の provider input は prepared source snapshot 内の `entrypoint` path
です。source 側の build service / CI は bundle
を作っても構いませんが、その結果は prepared source の file
として置きます。AppSpec には artifact kind や hash を 書きません。

```yaml
spec:
  entrypoint: dist/worker.mjs
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

## Data Assets

Takosumi AppSpec は artifact kind catalog を持ちません。`/v1/artifacts` は
operator が data blob を保管するための optional API で、そこに付く `kind` は
operator / connector distribution が定義する外部 metadata です。

bundled connector compatibility のため、reference distribution は data asset
metadata として次の `kind` を登録します。これは AppSpec の component kind でも
worker contract でもありません。

`oci-image | js-bundle | lambda-zip | static-bundle | wasm`

- `oci-image`
- `js-bundle`
- `lambda-zip`
- `static-bundle`
- `wasm`

Reference worker kind は data asset API を使わず、prepared source の
`spec.entrypoint` を読みます。詳細は [DataAsset Policy](./data-asset-policy.md)
と [Artifact GC](./artifact-gc.md) を参照してください。

## 関連ページ

- [AppSpec](./app-spec.md)
- [BuildSpec](./build-spec.md)
- [Provider plugin](./providers.md)
- [Connector Contract](./connector-contract.md)
- [Extending Takosumi](../extending.md)
