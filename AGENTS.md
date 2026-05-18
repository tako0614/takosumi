# AGENTS.md — Takosumi

This repository is **Takosumi**, a self-hostable PaaS. It reads `.takosumi.yml`
from source, creates an Installation in a Space, and records each apply as a
Deployment. It contains the type contract, the PaaS kernel, the materializer
host, the runtime-agent, the canonical installer, the CLI, and six per-cloud
provider packages as co-equal workspace members, all consumable from JSR.

Canonical contract:
[`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) (本
workspace の `packages/contract/`)。

## Workspace 構成

```
takosumi/
├── deno.json                (workspace root, 自身は publish しない)
├── packages/
│   ├── contract/             @takos/takosumi-contract       — AppSpec / KernelPlugin の型契約
│   ├── kernel/               @takos/takosumi-kernel         — HTTP server + installer pipeline + storage + workers
│   ├── plugins/              @takos/takosumi-plugins        — component kind catalog + materializer host + factories
│   ├── installer/            @takos/takosumi-installer      — .takosumi.yml parser + git fetch + deploy client
│   ├── runtime-agent/        @takos/takosumi-runtime-agent  — kernel ↔ tenant 間の gateway-manifest runtime
│   ├── cli/                  @takos/takosumi-cli            — `takosumi install` / `takosumi deploy` / `takosumi server` 等
│   ├── cloudflare-providers/ @takos/takosumi-cloudflare-providers   — Cloudflare 用 KernelPlugin factories
│   ├── aws-providers/        @takos/takosumi-aws-providers          — AWS 用 KernelPlugin factories
│   ├── gcp-providers/        @takos/takosumi-gcp-providers          — GCP 用 KernelPlugin factories
│   ├── kubernetes-providers/ @takos/takosumi-kubernetes-providers   — Kubernetes 用 KernelPlugin factory
│   ├── deno-deploy-providers/@takos/takosumi-deno-deploy-providers  — Deno Deploy 用 KernelPlugin factory
│   ├── selfhost-providers/   @takos/takosumi-selfhost-providers     — Self-host (docker / systemd / filesystem) 用 KernelPlugin factories
│   └── all/                  @takos/takosumi                — umbrella (上記 6 つを re-export、cloud provider 群は別 install)
├── docs/, deploy/, fixtures/
└── README.md, CONVENTIONS.md, CHANGELOG.md
```

## 中核概念 (= public concept は 3 つだけ)

| 概念             | 表現                                              |
| ---------------- | ------------------------------------------------- |
| **AppSpec**      | `.takosumi.yml` (= source root の 1 ファイル)     |
| **Installation** | Space に入った AppSpec (= 所有 / 課金 / 現在状態) |
| **Deployment**   | 1 回の apply 結果 (= 履歴 / audit / rollback)     |

これ以上の名詞は基本的に仕様 surface に出さない。 内部に `Resource` / `Secret` /
`Event` table はあるが public concept ではない。

## Component connection は publish / listen のみ

AppSpec の各 component は 2 つの edge だけを持つ:

- `publish: [<namespacePath>]` — 自分が出力する material を namespace registry
  に登録する
- `listen: { <namespacePath>: { as, prefix?, mount? } }` — 他 component の
  material を受け取り、 env / mount 等の形で注入する

旧 `use:` edge は廃止。 `${ref:...}` / `${secret-ref:...}` / `${bindings.*}`
等の interpolation syntax も AppSpec / docs / kernel から完全除去された。

## 基本方針

- **Source-to-runtime engine 専念**: kernel の責務は `.takosumi.yml` を読んで
  Installation を作り、 apply ごとに Deployment を記録することに限定する。
  workflow / CI / build pipeline / cron / hook は kernel の責務外であり、
  operator が別途 orchestrator で実装する。 AppSpec の `component.build` は
  artifact を得る最小 recipe (= `{ command, output }`) のみ表現可能。
- **`POST /v1/installations` is the canonical install entry point**: kernel は
  AppSpec を受ける first-class API を持ち、 CLI / GitHub Actions / 自前 CI /
  operator script はすべて 5 endpoint を直接叩く構成で動作する必要がある。
- **Public API surface は 5 endpoint だけ**: `POST /v1/installations/dry-run` /
  `POST /v1/installations` / `POST /v1/installations/{id}/deployments/dry-run` /
  `POST /v1/installations/{id}/deployments` /
  `POST /v1/installations/{id}/rollback`。 HTTP status は `failed_precondition`
  = **409**、 `resource_exhausted` = **413**。 Idempotency-Key header は
  v1 surface に含まれない (廃止)。
- **Substitutability で kernel pure を justify**:
  「持たないものリスト」(workflow / identity / billing / project convention)
  は、 kernel が Cloudflare Workers / Kubernetes / bare metal / 自前 runtime
  を越えて移植可能であるための **必要 条件** として保持する。 substitutability
  で justify できない responsibility は kernel に持ち込んでよい
  (実際には現状ほぼ無いが、 原則として「持たないもの list」自体を絶対視
  はしない)。
- **Runtime neutrality は `shared/runtime/` で集約**: kernel core から `Deno.*`
  / `process.*` / `node:*` の直接呼び出しは排除済み。 全 runtime primitive (env,
  exit, signal, fs, subprocess, serveHttp) は
  `packages/kernel/src/shared/runtime/` の `RuntimeAdapter` 経由で呼ぶ。 Deno /
  Node / Workers / Bun の差分はそこだけで吸収する。 新規 code path で `Deno.*`
  を直接呼ぶ PR は reject。
- **Image-first model**: component spec の `image` / `bundle` / `unit` は単なる
  URI 文字列。 artifact 取得は provider 側の責務 (K8s が image pull するのと
  同じ)。 AppSpec の `component.build` は最小 recipe のみ表現可能。
- **Takos 中立**: takos-git / Takos 固有 service ID への直接依存は kernel core
  から完全に除去済み。
- **Component kind catalog は extensible**: 新 kind は JSON-LD で URI publish +
  materializer 実装 で成立する (`CONVENTIONS.md` §6)。 catalog は 4 frozen kind
  ではなく、 任意 operator が任意 domain で新 kind を発行できる。 各 kind の
  JSON-LD document が **spec / publishes / listens / outputs を一体宣言** する。
  Takosumi curated 4 kind の正本 URI は `https://takosumi.com/kinds/v1/<name>`
  (= `worker` / `postgres` / `object-store` / `custom-domain`)。 `oidc` kind
  は takosumi-cloud に移動し、 本 repo には JSON-LD も materializer も無い。
- **Materializer = KernelPlugin | InlineMaterializer**: kind 実装は 2 形態を
  受理する。 (1) `KernelPlugin` factory を返す plain array (= Vite plugin pattern,
  cloud provider package が提供する形式) と (2) `createPaaSApp({ materializers:
  [...] })` に inline 関数を渡す形式。 後者は operator が任意 JS で書ける小さい
  recipe で十分なケース用。 plugin convention は実装の 1 形態に過ぎず、 inline
  関数でも contract を満たせば成立する。
- **Cloud provider plugins は別 package**: AWS / GCP / Cloudflare / Kubernetes /
  Deno Deploy / Self-host の materializer 実装は
  `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`
  に分離して publish する。 takosumi core (kernel / plugins / cli) は cloud SDK
  に依存しない。 operator は必要な provider package を import して `plugins:
  [...]` に attach する。 plugin marketplace / signed manifest / trusted publisher
  key / port-based plugin host / `createAdapters()` /
  `TakosumiKernelPluginManifest` / `KernelPluginPortKind` は kernel に持たない。
- **credential を kernel core に持たない**: provider package factory 経由で
  operator が opts として inject する。
- **identity / billing は kernel の外側**: per-Installation OIDC client 発行は
  Takosumi Accounts (operator-owned identity plane) の責務。 Takosumi Accounts
  は `operator.identity.oidc` namespace path に OIDC client material を publish
  し、 worker は `listen: { operator.identity.oidc: { as: env } }` で標準 env
  (`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` /
  `OIDC_REDIRECT_URIS`) を受け取る。 kernel core 自身は OIDC client を発行しない。
- **signing 機構を kernel が持たない**: ecosystem trust model は 「TLS + digest
  pin + 1 signing domain (OIDC)」 で、 OIDC ID token signing と install launch
  token signing は両方とも **Takosumi Accounts** が所有する。 kernel が直接
  関わる signing は **CatalogRelease verification のみ** であり、 これも
  publisher signing ではなく **operator-pinned sha256 digest** で fail-closed
  に検証する。 詳細は
  [docs/reference/supply-chain-trust.md](./docs/reference/supply-chain-trust.md)。
- 設計語彙は contract (AppSpec / Component / kind / publish / listen / build /
  materializer / Installation / Deployment) をそのまま採用。

## JSR publish layout

| Package                                | Version | 内容                                                                  |
| -------------------------------------- | ------- | --------------------------------------------------------------------- |
| `@takos/takosumi-contract`             | 3.0.0   | AppSpec / Component / KernelPlugin / Installer API 型契約             |
| `@takos/takosumi-kernel`               | 1.0.0   | HTTP server + installer pipeline + storage + workers                  |
| `@takos/takosumi-plugins`              | 1.0.0   | component kind catalog + materializer host + factories                |
| `@takos/takosumi-installer`            | 1.0.0   | .takosumi.yml parser + git fetch + deploy client                      |
| `@takos/takosumi-runtime-agent`        | 1.0.0   | kernel ↔ tenant gateway-manifest runtime                              |
| `@takos/takosumi-cli`                  | 1.0.0   | CLI (`takosumi install` / `takosumi deploy` 等)                       |
| `@takos/takosumi-cloudflare-providers` | 1.0.0   | Cloudflare (Workers / R2 / DNS) `KernelPlugin` factories              |
| `@takos/takosumi-aws-providers`        | 1.0.0   | AWS (Fargate / S3 / RDS / Route53) `KernelPlugin` factories           |
| `@takos/takosumi-gcp-providers`        | 1.0.0   | GCP (Cloud Run / GCS / Cloud SQL) `KernelPlugin` factories            |
| `@takos/takosumi-kubernetes-providers` | 1.0.0   | Kubernetes Deployment + Service `KernelPlugin` factory                |
| `@takos/takosumi-deno-deploy-providers`| 1.0.0   | Deno Deploy `KernelPlugin` factory                                    |
| `@takos/takosumi-selfhost-providers`   | 1.0.0   | Self-host (docker / systemd / filesystem / minio) factories           |
| `@takos/takosumi`                      | 1.0.0   | umbrella (core 6 つを再公開、 provider packages は別 install)         |

> Note: `@takos/` JSR scope は Takos が publish する **reference distribution**
> であり、 authority は publisher ではなく contract (`@takos/takosumi-contract`)
> の側にある。 contract-compatible な alternative publisher (例:
> `@example/takosumi-kernel`) は spec 上可能 — 現状は untested だが
> architectural privilege は持たない。

## Self-host 起点

```bash
# kernel server を起動
deno run -A jsr:@takos/takosumi-kernel

# CLI を install して install する
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi server                                  # in-process kernel
takosumi install --source ./                     # local source
takosumi install --remote https://kernel.example.com \
  --source git:https://github.com/example/notes#main \
  --space space_personal \
  --token $TAKOSUMI_INSTALLER_TOKEN
```

## Lint / Format / Test 共通設定

- Lint: `deno lint`
- Format: `deno fmt`
- Test: `deno test --allow-all` (workspace 全体)
- Type check: `deno task check`
- JSON-LD lint: `deno task lint:json-ld`
- Per-package: `cd packages/<name> && deno task check / test`

## 依存関係

- **Upstream**: `@takos/takosumi-contract` (型契約のみ、本 workspace の
  `packages/contract/`)
- **Downstream consumers**: 任意の operator が JSR から install して self-host
- **Cloud provider packages**: `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,
  deno-deploy,selfhost}-providers` は本 repo の workspace member であり、 各々
  独立 JSR package として publish される。 operator は必要な cloud だけを import
  する。
- **Takosumi Accounts (`takosumi-cloud/`)**: identity / billing / OIDC issuer /
  Installation ledger を保有する operator account plane の reference 実装。
  Takosumi Accounts が `operator.identity.oidc` namespace path に OIDC client
  material を publish し、 worker は `listen` で受け取る。 kernel 側に
  `kind: oidc` JSON-LD も materializer も持たない (= takosumi-cloud に移動)。
- **Takos ecosystem**: Takos product distribution は本 repo の上に Takos 固有
  artifact (deploy/distributions/*.json 等) を被せる。 これは `takos/` に残る
  別レイヤー。

## 作業ルール

- 新 cloud provider 追加時は `CONVENTIONS.md` §4 の手順に従う
  (`packages/<cloud>-providers/src/<kind>-<provider>.ts` 追加 + `mod.ts`
  re-export + tests)。
- 新 component kind を増やしたい場合は `CONVENTIONS.md` §6 の RFC プロセスに
  従う (= JSON-LD で URI publish + materializer 実装 の 2 段を踏む)。 catalog
  は frozen ではなく、 operator-defined kind も受理する。
- kernel 修正は `packages/kernel/` 内で完結させる。 Takos 固有 ID (`takos-app`
  等) は再導入しない。
- contract 変更を要する change は `packages/contract/` で coordination する。
- process role 名は `takosumi-{api,worker,router,runtime-agent,log-worker}`
  で固定。
- AppSpec の `component.build` は CI workflow ではない。 `jobs:` / `steps:` /
  `matrix:` / `triggers:` / pipeline DSL を導入してはいけない。
