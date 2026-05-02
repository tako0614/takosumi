# AGENTS.md — Takosumi

This repository is **Takosumi**, a shape / shape-provider / template bundle for
the Takosumi shape model (canonical contract:
[`takosumi-contract`](https://jsr.io/@takos/takosumi-contract)).

Takosumi is the **plugin host face** of the upstream PaaS work: it curates the
portable shape catalog, the per-cloud `ProviderPlugin` implementations, the
opinionated `Template` bundles, and the production wiring that injects real
lifecycle clients into each provider. It does **not** own the kernel itself.

The legacy 14-port `KernelPlugin` profile factories (aws / gcp / cloudflare /
kubernetes / selfhosted / hybrids) have been retired. The current model is
documented in `CONVENTIONS.md` and implemented under `src/shapes/`,
`src/shape-providers/`, and `src/templates/`.

## 基本方針

- 公開名: `@takos/takosumi` (JSR)
- Shape catalog ownership は Takos ecosystem。新 shape は RFC が必要
  (`CONVENTIONS.md` §6 参照)。
- 第三者は新 shape を増やすのではなく、既存 shape の `ProviderPlugin` を
  追加する。
- credential を直接読まない。`*LifecycleClient` を `factories.ts` 経由で inject
  する。
- 設計言語は contract 側の語彙 (shape / provider / template / capability /
  output) をそのまま採用する。

## Repository scope

- `src/shapes/`: portable shape contracts (`object-store@v1`, `web-service@v1`,
  `database-postgres@v1`, `custom-domain@v1`)
- `src/shape-providers/`: 各 shape の `ProviderPlugin` 実装 (`aws-s3`,
  `cloudflare-r2`, `cloud-run`, `k3s-deployment`, ...)
- `src/shape-providers/factories.ts`: production lifecycle wiring
- `src/templates/`: opinionated multi-shape bundles
- `src/providers/<cloud>/`: low-level HTTP gateway clients & service descriptors
  consumed by `factories.ts`
- `src/gateway/`, `src/runtime-agent/`, `src/extensions/`: operator-side wiring
  and runtime-agent adapters
- `deploy/`: provider 別 deploy artifact (Wrangler / Helm 等)
- `fixtures/live-provisioning/<provider>.shape-v1.json`: shape-model live
  provisioning fixtures
- `CONVENTIONS.md`: shape / provider / template 命名・形状規約 RFC

## Lint / Format / Test 共通設定

- Lint: `deno lint`
- Format: `deno fmt`
- Test: `deno test --allow-all`
- Type check: `deno task check`

## 依存関係

- **Upstream**: `takosumi-contract` (Shape / ProviderPlugin / Template の
  契約)
- **Downstream consumers**: Takosumi kernel を稼働させる任意の operator。
  Takos ecosystem は upstream から一段降りた consumer の一つ。
- **Excluded**: Takos 固有の distribution spec、Takos service 名 (`takos-app`
  等)。これらは consumer 側で持つ。

## 作業ルール

- 新 provider 追加時は `CONVENTIONS.md` §4 の手順に従う
  (shape-providers/<shape-id>/<provider-id>.ts 追加 + `factories.ts` の
  production 配線 + fixture + 必要なら template)。
- shape を増やしたい場合は `CONVENTIONS.md` §6 の RFC プロセスに従う。
- contract 変更を要する change は upstream `takosumi-contract` 側で
  coordination する。
