# Templates

> このページでわかること: manifest template の仕組みと使い方。

Takosumi kernel が受け取る Manifest は、 具体的な `resources[]` を持つ compiled
Shape manifest である。 Template の展開は installer / compiler の責務で、
`POST /v1/deployments` の前に終わっていなければならない。

## Contract

- Kernel manifest envelope は `apiVersion: "1.0"` + `kind: Manifest` +
  `resources[]`。
- Template は upstream installer が `resources[]` を生成するために使う。
- Template の結果は kernel request 前に完全展開される。
- Provider 選択は通常の provider resolution rule に従う。

## Immutability

Installer が template を resources に compile した時点で、 生成された resources
は Deployment に capture される。 後から template を変更しても既存 Deployment は
書き換えられない。 workload を更新したい場合は新しい compiled manifest を submit
する。

## Related

- [Manifest Spec](/reference/manifest-spec)
- [Manifest Expand Semantics](/reference/manifest-expand-semantics)
- [Shape Catalog](/reference/shapes)

## 関連ページ

- [Manifest Expand Semantics](/reference/manifest-expand-semantics)
- [Shape Catalog](/reference/shapes)
- [Provider Plugins](/reference/providers)
