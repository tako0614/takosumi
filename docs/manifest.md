# Manifest = AppSpec

> このページでわかること: Takosumi manifest = `.takosumi.yml` (AppSpec) の
> 参照先。

Takosumi の manifest は **`.takosumi.yml`** (= AppSpec) という 1 ファイルです。
source root に置くだけで install + deploy + rollback まで動きます。

仕様の正本は次のページにあります:

- [AppSpec (`.takosumi.yml`)](/reference/app-spec) — envelope / components /
  publish / listen / build recipe / interfaces / permissions の全 field 仕様
- [Kind Catalog](/reference/kind-catalog#component-kinds) — curated 4 種の kind
  schema (`worker` / `postgres` / `object-store` / `custom-domain`) +
  operator-defined kind の extension ルール (= `oidc` kind は takosumi-cloud
  に移動)
- [Installer API](/reference/installer-api) — 5 endpoint の wire spec (dry-run /
  apply / rollback)

## 最小例

```yaml
apiVersion: takosumi.dev/v1
kind: App

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
takosumi install --source ./ --space space_personal
```

を実行すれば Installation + 最初の Deployment が作られます。
