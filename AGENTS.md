# AGENTS.md — Takosumi

This repository is **Takosumi**, a self-hostable PaaS toolkit. It contains the
PaaS kernel, the shape / provider / template plugin host, and the CLI as
co-equal workspace packages, all consumable from JSR.

Canonical contract:
[`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract).

## Workspace 構成

```
takosumi/
├── deno.json                (workspace root, 自身は publish しない)
├── packages/
│   ├── kernel/              @takos/takosumi-kernel — HTTP server + apply pipeline + storage + workers
│   ├── plugins/             @takos/takosumi-plugins — shapes / shape-providers / templates / providers / runtime-agent
│   ├── cli/                 @takos/takosumi-cli — `takosumi deploy` / `takosumi server` 等のコマンド
│   └── all/                 @takos/takosumi — umbrella (上記 3 つを re-export)
├── docs/, deploy/, fixtures/
└── README.md, CONVENTIONS.md, CHANGELOG.md
```

## 基本方針

- **Manifest deploy engine 専念**: kernel の責務は `POST /v1/deployments` で
  closed `Manifest` envelope を受け取り、resource DAG を解決して apply する
  ことに限定する。workflow / git / build pipeline / cron / hook は kernel の
  責務外であり、`takosumi-git` 等の上位 product に委譲する。詳細は
  [docs/reference/architecture/workflow-extension-design.md](./docs/reference/architecture/workflow-extension-design.md)。
- **Image-first model**: shape spec の `image` / `bundle` / `unit` は単なる URI
  文字列。 artifact 取得は provider 側の責務 (K8s が image pull するのと同じ)。
  manifest spec に `compute.build.fromWorkflow` 等の build
  概念は今後持ち込まない (既存 `validateWorkflowBuild` は deprecation
  経由で削除予定)。
- **Takos 中立**: takos-git / Takos 固有 service ID への直接依存は kernel core
  から完全に除去済み。
- **Shape catalog は Takosumi 所有**: 新 shape は RFC ベース (`CONVENTIONS.md`
  §6)。 第三者は新 shape を増やすのではなく既存 shape の provider を追加する。
  workflow / cron / hook を kernel-known shape として追加することは行わない。
- **credential を kernel core に持たない**: `factories.ts` 経由で operator が
  inject する。
- 設計語彙は contract (shape / provider / template / capability / output)
  をそのまま採用。

## JSR publish layout

| Package                    | Version | 内容                                                     |
| -------------------------- | ------- | -------------------------------------------------------- |
| `@takos/takosumi-contract` | 1.0.0+  | Shape / ProviderPlugin / Template の型契約 (別 repo)     |
| `@takos/takosumi-kernel`   | 0.1.0+  | HTTP server + apply pipeline + storage + workers         |
| `@takos/takosumi-plugins`  | 0.2.0+  | shape catalog + provider plugins + templates + factories |
| `@takos/takosumi-cli`      | 0.1.0+  | CLI (`takosumi deploy` 等)                               |
| `@takos/takosumi`          | 0.2.0+  | umbrella (kernel + plugins + cli を再公開)               |

## Self-host 起点

```bash
# kernel server を起動
deno run -A jsr:@takos/takosumi-kernel

# CLI を install してデプロイ
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi server                  # in-process でも起動可
takosumi deploy ./manifest.yml   # local mode (in-process kernel)
takosumi deploy ./manifest.yml --remote https://kernel.example.com --token $T
```

## Lint / Format / Test 共通設定

- Lint: `deno lint`
- Format: `deno fmt`
- Test: `deno test --allow-all` (workspace 全体)
- Type check: `deno task check`
- Per-package: `cd packages/<name> && deno task check / test`

## 依存関係

- **Upstream**: `@takos/takosumi-contract` (型契約のみ、独立 repo)
- **Downstream consumers**: 任意の operator が JSR から install して self-host
- **`takosumi-git` (上位 sibling product)**: git 連携 / workflow runner /
  artifact build / manifest generation を担い、本 kernel の
  `POST /v1/deployments` を叩く HTTP client として接続する。本 kernel は
  `takosumi-git` の存在を 知らない (kernel は manifest を受け取るだけ)。
- **Takos ecosystem**: Takos product distribution は本 repo の上に Takos 固有
  artifact (deploy/distributions/*.json 等) を被せる。これは `takos/`
  に残る別レイヤー。

## 作業ルール

- 新 provider 追加時は `CONVENTIONS.md` §4 の手順に従う
  (`packages/plugins/src/shape-providers/<shape-id>/<provider-id>.ts` 追加 +
  `factories.ts` の production 配線 + fixture + 必要なら template)。
- shape を増やしたい場合は `CONVENTIONS.md` §6 の RFC プロセスに従う。
- kernel 修正は `packages/kernel/` 内で完結させる。Takos 固有 ID (`takos-app`
  等) は再導入しない。
- contract 変更を要する change は upstream `takos/takosumi-contract` repo 側で
  coordination する。
- process role 名は `takosumi-{api,worker,router,runtime-agent,log-worker}`
  で固定。
- workflow / git 連携 / build pipeline / cron / hook 関連の change は本 repo
  ではなく `takosumi-git` 側で行う。本 repo に該当機能を追加してはいけない。
  既存 `compute.build.fromWorkflow` 等の deprecated path も新 client は
  使わず、`takosumi-git` 経由で manifest を生成する。
