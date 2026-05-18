# Shape Catalog

> このページでわかること: Component kind catalog (= curated 4 種 +
> operator-defined kind) の参照先。

v1 manifest (= `.takosumi.yml`) では各 component が `kind` を持ち、 catalog
に登録された curated 4 種のいずれか、 または operator が自前 `.jsonld` で
publish した URI を指します。 仕様の正本は次のページにあります。

- [Component Kind Catalog](./component-kind-catalog.md) — curated 4 kind の spec
  / outputs / publish / listen 仕様
- [AppSpec (`.takosumi.yml`)](./app-spec.md) — `.takosumi.yml` 全体仕様
- [Installer API](./installer-api.md) — dry-run / apply / rollback の 5 endpoint
