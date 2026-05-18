# Component Kind Catalog

> このページでわかること: `.takosumi.yml` の `components[*].kind` で使える 5
> 種類 の schema と output。

Takosumi catalog は v1 で **5 kind を frozen** に保ちます。 新 kind の追加は
`CONVENTIONS.md` §6 RFC を要します。 新しいクラウド対応は kind を fork するの
ではなく、 既存 kind に provider plugin を追加することで提供されます。

Source: `packages/contract/src/app-spec.ts` (contract),
`packages/plugins/src/kinds/<kind>.ts` (5 種 bundled)。

| `kind`          | 用途                                                              |
| --------------- | ----------------------------------------------------------------- |
| `worker`        | Serverless HTTP service (= JS bundle or container artifact)       |
| `postgres`      | Managed PostgreSQL                                                |
| `object-store`  | S3-compatible bucket                                              |
| `oidc`          | OIDC consumer mount point (= Installation 内部で client 自動発行) |
| `custom-domain` | Public domain + TLS termination                                   |

## `outputs` の reserved 名前

全 kind 横断で次の output field 名は reserved meaning を持ち、 consumer は
provider 差分に関係なく安定 semantics に依存できます。

| name       | 意味                                         |
| ---------- | -------------------------------------------- |
| `url`      | scheme-bearing public URL (`https://...`)    |
| `endpoint` | service / API endpoint URL                   |
| `id`       | provider-scope identifier                    |
| `version`  | provider-scope version / revision identifier |

これらの名前を持つ新規 output 追加は RFC を要します。

## `worker`

Serverless HTTP service。 JS bundle (`build.output`) または container image を
artifact として動きます。

### Spec

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    routes:
      - /
      - /api/*
    use:
      db:
        env: DATABASE_URL
      auth:
        mount: oidc
```

| field    | required | 説明                                             |
| -------- | -------- | ------------------------------------------------ |
| `build`  | yes      | `{ command, output }` (= artifact 生成 recipe)   |
| `routes` | no       | route pattern list (= `/`, `/api/*`, `*.host/*`) |
| `use`    | no       | 依存 edge (= db / object-store / oidc / domain)  |

### Outputs

| field     | 意味                             |
| --------- | -------------------------------- |
| `url`     | 割り当てられた public URL        |
| `id`      | provider-scope worker identifier |
| `version` | 現在 deploy 中の bundle version  |

## `postgres`

Managed PostgreSQL instance。

### Spec

```yaml
components:
  db:
    kind: postgres
    spec:
      class: standard
```

| field        | required | 説明                                                 |
| ------------ | -------- | ---------------------------------------------------- |
| `spec.class` | no       | `standard` / `small` / `large` (default: `standard`) |

### Outputs

| field              | 意味                                    |
| ------------------ | --------------------------------------- |
| `connectionString` | client が使う connection URL (= secret) |
| `host`             | hostname                                |
| `port`             | port number                             |
| `database`         | database name                           |
| `username`         | role name                               |

### `use` edge での参照

```yaml
components:
  web:
    use:
      db:
        env: DATABASE_URL # → connectionString が DATABASE_URL に inject
```

`envPrefix` を使うと全 output field が展開されます (= `DB_HOST`, `DB_PORT`,
`DB_DATABASE`, `DB_USERNAME`, `DB_CONNECTIONSTRING`)。

## `object-store`

S3-compatible bucket。 旧 `object-store@v1` の keep。

### Spec

```yaml
components:
  media:
    kind: object-store
```

field なし (= デフォルト bucket を generated)。

### Outputs

| field       | 意味                         |
| ----------- | ---------------------------- |
| `bucket`    | bucket name                  |
| `endpoint`  | S3 endpoint URL              |
| `region`    | bucket region                |
| `accessKey` | access key id (= secret)     |
| `secretKey` | secret access key (= secret) |

### `use` edge での参照

```yaml
components:
  web:
    use:
      media:
        envPrefix: BLOB_ # → BLOB_BUCKET / BLOB_ENDPOINT / BLOB_REGION / BLOB_ACCESSKEY / BLOB_SECRETKEY
```

## `oidc`

OIDC consumer mount point。 旧 `identity.oidc@v1` use edge に相当する新 kind。

`oidc` component を宣言すると、 Takosumi は Installation 作成時に Takosumi
Accounts (= operator-owned identity plane) で per-Installation OIDC client を
自動発行し、 `use: { mount: oidc }` した worker に下記環境変数を inject します。

### Spec

```yaml
components:
  auth:
    kind: oidc
    redirectPaths:
      - /api/auth/callback
    scopes: [openid, profile, email]
```

| field           | required | 説明                                           |
| --------------- | -------- | ---------------------------------------------- |
| `redirectPaths` | yes      | OIDC redirect URI path list                    |
| `scopes`        | no       | 要求 scope list (default: `[openid, profile]`) |

### Outputs (= injected env via `mount: oidc`)

| env var              | 意味                                |
| -------------------- | ----------------------------------- |
| `OIDC_ISSUER_URL`    | Takosumi Accounts issuer URL        |
| `OIDC_CLIENT_ID`     | Installation-scoped client id       |
| `OIDC_CLIENT_SECRET` | Installation-scoped client secret   |
| `OIDC_REDIRECT_URIS` | comma-separated redirect URI 完全形 |

worker の OIDC consumer 実装は上記 env var を読んで Takosumi Accounts に対する
OIDC consumer flow を実装します (= authorization code grant + PKCE + ID token
validate)。

## `custom-domain`

DNS record + public domain TLS termination。

### Spec

```yaml
components:
  domain:
    kind: custom-domain
    name: notes.example.com
    use:
      web:
        target: url
```

| field          | required | 説明                                            |
| -------------- | -------- | ----------------------------------------------- |
| `name`         | yes      | FQDN                                            |
| `use.<target>` | yes      | 他 worker component への edge (= `target: url`) |

### Outputs

| field           | 意味                           |
| --------------- | ------------------------------ |
| `fqdn`          | resolved FQDN                  |
| `certificateId` | TLS certificate identifier     |
| `nameservers`   | (optional) DNS nameserver list |

## Cross-references

- [AppSpec](./app-spec.md) — `.takosumi.yml` 全体仕様
- [Installer API](./installer-api.md) — dry-run / apply / rollback の wire spec
- [Architecture: Manifest model](./architecture/manifest-model.md) — kind と
  provider plugin の関係
