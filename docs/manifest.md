# Manifest = AppSpec

> このページでわかること: Takosumi manifest = `.takosumi.yml` (AppSpec) の
> 参照先。

> **Wave N planned (2026-05-21 RFC stage)**: 本 teaser が示す curated 4 kind
> 名 + `build:` field は Wave N で削除予定 (= kernel pure contract executor 化、
> build は別 `kind: build` component に移管、 kind は operator distribution が
> JSON-LD
>
> - plugin で持ち込む)。 詳細 design は
>   [RFC 0001](./rfc/0001-kernel-kind-agnostic.md) を参照。

Takosumi の manifest は **`.takosumi.yml`** (= AppSpec) という 1 ファイルです。
source root に置くだけで install + deploy + rollback まで動きます。

仕様の正本は次のページにあります:

- [AppSpec (`.takosumi.yml`)](./reference/app-spec.md) — envelope / components /
  publish / listen / build recipe の全 field 仕様
- [Kind Catalog](./reference/kind-catalog.md#component-kinds) — curated 4 種の
  kind schema (`worker` / `postgres` / `object-store` / `custom-domain`) +
  operator-defined kind の extension ルール
- [Installer API](./reference/installer-api.md) — 5 endpoint の wire spec
  (dry-run / apply / rollback)

## 最小例

```yaml
apiVersion: v1

metadata:
  id: com.example.notes
  name: Example Notes

components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      - com.example.notes.db

  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes: ["/"]
    listen:
      com.example.notes.db:
        as: env
        prefix: DATABASE_
```

これを `.takosumi.yml` として source root に置き、

```bash
takosumi install --source . --space space_personal
```

を実行すれば Installation + 最初の Deployment が作られます。

## 次に読む

- [AppSpec (`.takosumi.yml`)](./reference/app-spec.md) — envelope / components
  の 全 field 仕様
- [Kind Catalog](./reference/kind-catalog.md#component-kinds) — kind ごとの spec
  / publishes / listens / outputs
- [Installer API](./reference/installer-api.md) — 5 endpoint の wire spec
- [Quickstart](/getting-started/quickstart) — git clone から first deploy まで
- [Provider Plugins](./reference/providers.md) — operator が attach する
  provider factory 一覧
