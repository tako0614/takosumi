# Operator

> このページでわかること: Takosumi を operator として self-host する際の主要
> docs index。

Takosumi は self-hostable な PaaS であり、 operator は kernel + runtime-agent
を起動し、 cloud / on-prem provider plugin を attach し、 production
を維持する責務を持つ。 ここでは operator が辿るべき順序で 3 leaf page と関連
reference をまとめる。

## Operator leaf pages

| ページ                                 | このページでわかること                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Bootstrap](/operator/bootstrap)       | kernel に bundled materializer plugin (`KernelPlugin` plain array) を attach する初期設定の手順        |
| [Self-host Notes](/operator/self-host) | Takosumi をセルフホストする際の注意点・前提条件・production checklist (env vars / agent / artifact GC) |
| [Version Alignment](/operator/upgrade) | Takosumi packages の current version alignment と schema ledger の不変条件                             |

## 読む順序の目安

1. [Bootstrap](/operator/bootstrap) — `createPaaSApp({ plugins: [...] })` で
   provider plugin を attach する最小構成を読み、 自 cloud / on-prem に 合わせた
   factory を選ぶ
2. [Self-host Notes](/operator/self-host) — production deploy 前に必要な env /
   secret / DB encryption / agent token などの fail-closed condition を確認
3. [Version Alignment](/operator/upgrade) — 6 package の current alignment と
   migration ledger の不変条件を確認し、 upgrade 手順の前提を揃える

## 関連 reference

- [Environment Variables](../reference/env-vars.md) — `TAKOSUMI_*` 一覧
- [Kernel HTTP API](../reference/kernel-http-api.md) — installer / artifact /
  internal API の wire spec
- [Runtime-Agent API](../reference/runtime-agent-api.md) — kernel ↔ agent
  envelope
- [Provider Plugins](../reference/providers.md) — 20 default + 1 opt-in provider
  の実装と capabilities
- [Lifecycle Protocol](../reference/lifecycle.md) — apply / destroy / lock 詳細
- [Observability Stack](../reference/observability-stack.md) — SLI / SLO / alert
  routing の初期 contract
