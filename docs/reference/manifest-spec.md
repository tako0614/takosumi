# Manifest Spec

> このページでわかること: v1 manifest = `.takosumi.yml` (AppSpec) の参照先。

Takosumi の manifest は **`.takosumi.yml`** (= AppSpec) という 1 ファイルです。
仕様の正本は次の 2 ページにあります。

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — envelope / components / publish /
  listen / build recipe / interfaces / permissions の全 field 仕様
- [Component Kind Catalog](./component-kind-catalog.md) — curated 4 種の
  component kind schema (`worker` / `postgres` / `object-store` /
  `custom-domain`) + operator-defined kind の extension ルール (= `oidc` kind は
  takosumi-cloud に移動)

API surface は [Installer API](./installer-api.md) の 5 endpoint に閉じます。
