# Takosumi Documentation

Takosumi の portable resource model (Shape + Provider + Template) と production
wiring に関する docs。canonical contract の repo (`takosumi-contract`) と本 repo
(`@takos/takosumi`) の境界もここで説明する。

## ページ一覧

- [Shape Catalog](./shape-catalog.md) — 4 つの curated Shape
  (`object-store@v1` / `web-service@v1` / `database-postgres@v1` /
  `custom-domain@v1`) と spec / capabilities / outputs 契約。
- [Provider Plugins](./provider-plugins.md) — bundled 18 provider を Shape
  別にグルーピング、各 provider の capability set と lifecycle adapter の出処。
- [Templates](./templates.md) — `selfhosted-single-vm@v1` /
  `web-app-on-cloudflare@v1` の inputs / expansion / use case。
- [Manifest (Shape Model)](./manifest.md) — manifest envelope
  (`resources[]` / `template:`) と `${ref:...}` / `${secret-ref:...}` syntax、
  capability `requires` semantics、DAG / rollback。
- [Operator Bootstrap](./operator-bootstrap.md) —
  `createTakosumiProductionProviders(opts)` の per-cloud option types、
  gateway URL pattern、kernel apply pipeline への wire 例。
- [Extending](./extending.md) — 新 provider 追加 / 新 Shape RFC / 新
  template 追加の手順。

## 関連

- 命名規約: [`../CONVENTIONS.md`](../CONVENTIONS.md)
- 本 repo の方針: [`../AGENTS.md`](../AGENTS.md)
- canonical contract の docs: 上流 `takosumi-contract` repo を参照
