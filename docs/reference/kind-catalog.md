# Kind Catalog {#kind-catalog}

Kind catalog は `components.<name>.kind` が指す runtime / resource contract の
索引です。AppSpec は kind 名と `spec` を書き、operator が attach した
materializer が具体 substrate に変換します。

## Component kinds

Takosumi docs で扱う current built-in kind は次の 4 つです。

| Kind | 用途 | 代表 outputs |
| --- | --- | --- |
| `worker` | HTTP worker / serverless runtime | `url`, `routes`, `artifactDigest` |
| `postgres` | PostgreSQL database | `host`, `port`, `database`, `connectionString` |
| `object-store` | S3-compatible bucket | `bucket`, `endpoint`, `region` |
| `custom-domain` | DNS record + TLS termination | `hostname`, `target`, `certificateStatus` |

`kind` は short alias または operator が解決できる URI を使います。operator-defined
kind は JSON-LD descriptor と materializer を operator が用意します。

## `worker`

```yaml
components:
  web:
    kind: worker
    build:
      command: npm run build
      output: dist/worker.js
    spec:
      routes:
        - app.example.local/*
```

`spec.routes`、compatibility date、artifact reference などは worker kind の
convention です。AppSpec root の field ではありません。

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
      hostname: app.example.com
      target: com.example.app.web
```

DNS、certificate、ingress wiring は provider convention です。

## JSON-LD descriptor

operator-defined kind は JSON-LD descriptor で `spec`、`publishes`、`listens`、
`outputs` を宣言します。kernel は descriptor と materializer の contract が揃う
ことを前提に、AppSpec component を解決します。

```json
{
  "@context": "https://takosumi.com/contexts/kinds/v1",
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

Artifact kind は uploaded / built data asset の type です。runtime-agent connector
は受け付ける artifact kind を宣言し、mismatch を apply 前に reject します。

| Artifact kind | 用途 |
| --- | --- |
| `js-bundle` | JavaScript / TypeScript worker bundle |
| `oci-image` | OCI image reference |
| `static-assets` | static asset bundle |
| `source-archive` | source snapshot |

詳細は [DataAsset Policy](./data-asset-policy.md) と
[Artifact GC](./artifact-gc.md) を参照してください。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Provider Plugins](./providers.md)
- [Connector Contract](./connector-contract.md)
- [Extending Takosumi](../extending.md)
