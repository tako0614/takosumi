# Component Kind Catalog

> このページでわかること: `.takosumi.yml` の `components[*].kind` で使える 4
> kind の spec / publishes / listens / outputs。 各 kind の JSON-LD document が
> **これら 4 項目を一体宣言** します。

Takosumi catalog の 4 built-in kind は `spec/contexts/kinds/v1/<name>.jsonld` が
canonical source です。 各 .jsonld は次を 1 つの document で宣言します:

1. **`spec`** (= JSON Schema 2020-12) — AppSpec の `components.<name>.spec`
   に書ける構造。
2. **`publishes`** (= array) — この kind が namespace registry に publish する
   material と target namespace path。
3. **`listens`** (= object) — この kind が listen 可能な namespace path と、
   受信した material をどう注入するか (`shape` / `envMap`)。
4. **`outputs`** (= array) — apply 後に provider が返す値の reserved 名前 +
   meaning。

新 kind の追加は JSON-LD document を任意 domain で publish し、 materializer
実装 (= 形式任意) を operator が `createPaaSApp({ materializers: [...] })` に
渡せば成立します。 catalog は 4 種「frozen」 ではなく、 任意の operator が
拡張可能です。

| `kind` (alias)  | URI                                           | 用途                                           |
| --------------- | --------------------------------------------- | ---------------------------------------------- |
| `worker`        | `https://takosumi.com/kinds/v1/worker`        | Serverless HTTP service (= JS bundle artifact) |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`      | Managed PostgreSQL                             |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store`  | S3-compatible bucket                           |
| `custom-domain` | `https://takosumi.com/kinds/v1/custom-domain` | Public domain + TLS termination                |

## `oidc` kind は takosumi-cloud に移動

旧 `kind: oidc` は takosumi core の責務外として削除しました。 takosumi-cloud (=
Takosumi Accounts operator distribution) が `operator.identity.oidc` namespace
path に OIDC client material を publish します。 worker は
`listen.operator.identity.oidc` で標準 env (`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID`
/ `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS`) を受け取ります。

詳細は takosumi-cloud の対応 docs (= 同 repo
`spec/contexts/kinds/v1/oidc.jsonld` 予定) を参照してください。 takosumi kernel
は OIDC client を発行しません。

## `outputs` の reserved 名前

全 kind 横断で次の output field 名は reserved meaning を持ち、 consumer は
provider 差分に関係なく安定 semantics に依存できます。

| name       | 意味                                         |
| ---------- | -------------------------------------------- |
| `url`      | scheme-bearing public URL (`https://...`)    |
| `endpoint` | service / API endpoint URL                   |
| `id`       | provider-scope identifier                    |
| `version`  | provider-scope version / revision identifier |

これらの名前を持つ新規 output 追加は kind JSON-LD の改訂を要します。

## `worker`

Serverless HTTP service。 JS bundle (`build.output`) を artifact
として動きます。

### Spec

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      compatibilityDate: "2026-01-01"
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
      operator.identity.oidc:
        as: env
```

| field                    | required                  | 説明                                           |
| ------------------------ | ------------------------- | ---------------------------------------------- |
| `build`                  | yes                       | `{ command, output }` (= artifact 生成 recipe) |
| `spec.compatibilityDate` | yes (for direct artifact) | Cloudflare 互換 date                           |
| `listen`                 | no                        | listen 対象 namespace path                     |

> Wave J で worker.jsonld から `routes` 宣言を削除しました。 worker materializer
> (= `@takos/takosumi-cloudflare-providers` 等の shape provider) は
> `spec.routes` (string array) を実装慣習として読みますが、 worker kind contract
> には宣言されません (= 「底は自由」 原則)。 別の materializer 実装は routes
> を別の表現 (= 別 kind の namespace pub 等) で扱っても構いません。

### Publishes

`worker` は **`<app-id>.<component-name>`** namespace path に下記 material を
publish します:

```text
{ url, id }
```

### Listens

`worker` は任意の sibling namespace path を `as: env` で listen し、 受信した
material を `${PREFIX}_*` env var として注入します (`prefix` option で PREFIX
を選択)。 詳細な envMap は AppSpec listen options が決定します。

### Outputs

| field     | 意味                             |
| --------- | -------------------------------- |
| `url`     | 割り当てられた public URL        |
| `id`      | provider-scope worker identifier |
| `version` | 現在 deploy 中の bundle version  |

### Capabilities

`scale-to-zero`, `always-on`, `websocket`, `long-request`, `sticky-session`,
`private-networking`, `geo-routing`, `crons`。

## `postgres`

Managed PostgreSQL instance。

### Spec

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
      backups:
        enabled: true
        retentionDays: 7
    publish:
      - com.example.notes.db
```

| field             | required | 説明                                         |
| ----------------- | -------- | -------------------------------------------- |
| `spec.version`    | yes      | PostgreSQL major version (= `15` / `16`)     |
| `spec.size`       | yes      | `small` / `medium` / `large` / `xlarge`      |
| `spec.storage`    | no       | `{ sizeGiB, type }`                          |
| `spec.backups`    | no       | `{ enabled, retentionDays }`                 |
| `spec.extensions` | no       | enable する extension list (= `pgvector` 等) |

### Publishes

`<app-id>.<component-name>` namespace path に下記 material を publish:

```text
{ host, port, database, username, passwordSecretRef, connectionString }
```

### Listens

`postgres` は listen を持ちません (= 空 `{}`)。

### Outputs

| field               | 意味                                    |
| ------------------- | --------------------------------------- |
| `host`              | hostname                                |
| `port`              | port number (typically 5432)            |
| `database`          | database name                           |
| `username`          | role name                               |
| `passwordSecretRef` | secret store reference (= secret)       |
| `connectionString`  | client が使う connection URL (= secret) |

### 接続例 (= listen 側)

```yaml
components:
  web:
    kind: worker
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
        # → DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME /
        #    DB_PASSWORDSECRETREF / DB_CONNECTIONSTRING を env に注入
```

## `object-store`

S3-compatible bucket。

### Spec

```yaml
components:
  media:
    kind: object-store
    spec:
      name: notes-media
      versioning: true
    publish:
      - com.example.notes.media
```

| field             | required | 説明                                    |
| ----------------- | -------- | --------------------------------------- |
| `spec.name`       | yes      | logical bucket name                     |
| `spec.public`     | no       | anonymous read 許可                     |
| `spec.versioning` | no       | versioning enable                       |
| `spec.region`     | no       | provider region                         |
| `spec.lifecycle`  | no       | `{ expireAfterDays, archiveAfterDays }` |

### Publishes

`<app-id>.<component-name>` namespace path に下記 material を publish:

```text
{ bucket, endpoint, region, accessKeyRef, secretKeyRef }
```

### Listens

`object-store` は listen を持ちません (= 空 `{}`)。

### Outputs

| field          | 意味                                        |
| -------------- | ------------------------------------------- |
| `bucket`       | bucket name                                 |
| `endpoint`     | S3 endpoint URL                             |
| `region`       | bucket region                               |
| `accessKeyRef` | access key id 用 secret store reference     |
| `secretKeyRef` | secret access key 用 secret store reference |

### 接続例 (= listen 側)

```yaml
components:
  web:
    kind: worker
    listen:
      com.example.notes.media:
        as: env
        prefix: BLOB_
        # → BLOB_BUCKET / BLOB_ENDPOINT / BLOB_REGION /
        #    BLOB_ACCESSKEYREF / BLOB_SECRETKEYREF
```

## `custom-domain`

DNS record + public domain TLS termination。

### Spec

```yaml
components:
  domain:
    kind: custom-domain
    spec:
      name: notes.example.com
      certificate:
        kind: auto
    listen:
      com.example.notes.web:
        as: target
```

| field              | required | 説明                                              |
| ------------------ | -------- | ------------------------------------------------- |
| `spec.name`        | yes      | FQDN (e.g. `notes.example.com`)                   |
| `spec.certificate` | no       | `{ kind: auto / managed / provided, secretRef? }` |
| `spec.redirects`   | no       | HTTP redirect rule list                           |
| `listen.<worker>`  | yes      | `as: target` で upstream worker namespace         |

### Publishes

`<app-id>.<component-name>` namespace path に下記 material を publish:

```text
{ fqdn, certificateId }
```

### Listens

`custom-domain` は任意の sibling worker namespace を `as: target` で listen し、
publish material の `url` を upstream として使用します。

### Outputs

| field           | 意味                              |
| --------------- | --------------------------------- |
| `fqdn`          | resolved FQDN                     |
| `certificateId` | provider-scope TLS certificate id |
| `nameservers`   | (optional) DNS nameserver list    |

## Cross-references

- [AppSpec](./app-spec.md) — `.takosumi.yml` 全体仕様
- [Installer API](./installer-api.md) — dry-run / apply / rollback の wire spec
- [Manifest](./manifest.md#data-model) — kind と namespace registry の関係
