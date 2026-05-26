# AGENTS.md — Takosumi

This repository is **Takosumi**, an operator-portable PaaS contract and reference kernel. It reads `.takosumi.yml` from source, creates an Installation in a Space, and records each apply as a Deployment. It contains the type contract, the PaaS kernel, the official type catalog helpers, the runtime-agent, the canonical installer, the CLI, grouped provider packages, and individually publishable external adapter packages as co-equal workspace members, all consumable from JSR.

**Spec status (= Wave L AppSpec apiVersion group prefix removal 完遂、 2026-05-20、 Wave K AppSpec root envelope minimization 2026-05-20 / Wave J Component contract minimization 2026-05-19 の延長)**: Takosumi の AppSpec contract は完全 kind-agnostic な単一 spec で閉じている。 AppSpec root は `{ apiVersion, metadata, components }` の 3 field、 Component は `{ kind, spec, publish, listen }` の 4 field のみ。 `apiVersion` は bare `"v1"` 固定 (Wave L 以降 k8s 風 group prefix `takosumi.dev/` は redundant な vestige として削除済、 Takosumi parser は `.takosumi.yml` のみ扱う)。 `apiVersion: v1` 単独で schema を discriminate するため、旧 `kind: App` root field は Wave K で物理削除済 (= 入力に `kind:` を root に含む YAML は unknown-key として reject)。内部 Component の `kind:` field (= component type discriminator) は当然 keep。kind の意味は operator-injected `kindAliases`、descriptor metadata、 Space policy、operator implementation binding が与える。5-endpoint installer API は AppSpec / source / apply request を運ぶ transport であり、kind semantics の定義元ではない。6 別 cloud provider package と operator-attached `KernelPlugin` は reference kernel の implementation binding 例。旧 `use:` edge、placeholder syntax、中間 manifest compile 形式、 workflow-reference field、publisher-trust scheme、 external publication special-case、 Wave J で削除した **Component.routes / AppSpec.interfaces / AppSpec.permissions**、 Wave K で削除した **AppSpec root の `kind: App` field**、そして Wave L で削除した **`apiVersion` の `takosumi.dev/` group prefix** は全て物理削除済。 routes / launch endpoint / capability request は kind の open `spec:` 内、component `publish` / `listen`、または external publication で表現する (= 「底は自由」原則: 実装層の convention は spec contract の外)。Takosumi official type catalog の descriptor documents は `packages/plugins/spec/kinds/` に保存され、 `https://takosumi.com/kinds/v1/*` で publish される。operator はその catalog を採用してもよいし、自分の catalog を採用してもよい。production deployable (= bare core と full-feature 両 smoke green、kernel pipeline は routes を処理しない)。これ以降の spec 変更は CHANGELOG / RFC ベースの個別 evolution として扱う。

Canonical contract: [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) (本 workspace の `packages/contract/`)。

## Workspace 構成

```
takosumi/
├── deno.json                (workspace root, 自身は publish しない)
├── packages/
│   ├── contract/             @takos/takosumi-contract       — AppSpec / Installer API DTO と non-normative helper
│   ├── kernel/               @takos/takosumi-kernel         — HTTP server + installer pipeline + storage + workers
│   ├── plugins/              @takos/takosumi-plugins        — official catalog helpers + reference adapter helpers
│   ├── installer/            @takos/takosumi-installer      — .takosumi.yml parser + git fetch + deploy client
│   ├── runtime-agent/        @takos/takosumi-runtime-agent  — operator-internal reference execution / connector host
│   ├── cli/                  @takos/takosumi-cli            — `takosumi install` / `takosumi deploy` / `takosumi server` 等
│   ├── plugin-*/             @takos/takosumi-plugin-<kind>-<backend> — external adapter `KernelPlugin` factories
│   ├── cloudflare-providers/ @takos/takosumi-cloudflare-providers   — Cloudflare 用 KernelPlugin factories
│   ├── aws-providers/        @takos/takosumi-aws-providers          — AWS 用 KernelPlugin factories
│   ├── gcp-providers/        @takos/takosumi-gcp-providers          — GCP 用 KernelPlugin factories
│   ├── kubernetes-providers/ @takos/takosumi-kubernetes-providers   — Kubernetes 用 KernelPlugin factory
│   ├── deno-deploy-providers/@takos/takosumi-deno-deploy-providers  — Deno Deploy 用 KernelPlugin factory
│   └── all/                  @takos/takosumi                — umbrella (上記 6 つを re-export、cloud provider 群は別 install)
├── docs/, deploy/, fixtures/
└── README.md, CONVENTIONS.md, CHANGELOG.md
```

## 中核概念 (= public concept は 3 つだけ)

| 概念             | 表現                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| **AppSpec**      | `.takosumi.yml` (= source root の 1 ファイル)                            |
| **Installation** | Space-scoped AppSpec core record (= current Deployment pointer / status) |
| **Deployment**   | 1 回の apply 結果 (= 履歴 / audit / rollback)                            |

仕様 surface の名詞はこの 3 つに閉じる。内部 table は `Resource` / `Secret` / `Event` などとして実装側に置く。 ownership / billing は Takosumi Cloud などの operator account-plane projection が保持する。

## Component connection は publish / listen のみ

AppSpec の各 component は local publication と local binding だけを持つ:

- `publish: { <name>: { as } }` — 自分が出力する material を同じ AppSpec 内の `component.publication` として offer する
- `listen: { <binding>: { from, as, prefix?, mount?, required? } }` — 同じ AppSpec 内の `component.publication` または operator-owned external publication path を受け取り、 env / mount / upstream 等の形で注入する

旧 `use:` edge は廃止。 `${ref:...}` / `${secret-ref:...}` / `${bindings.*}` 等の interpolation syntax も AppSpec / docs / kernel から完全除去された。

## Worldview / Wave N (= kernel kind-agnostic 化)

Wave J / K / L の minimization sequence を継承し、Wave N は component kind の意味を operator distribution が持ち込む model へ進んでいる。component kind externalization は 2026-05-21 に実装済み: `Component.kind` は opaque string、 kernel-owned kind semantics は 0、short alias resolution は operator が `kindAliases` で注入する。`Component.build` は削除済みで、build / prepare は operator-owned build service が prepared source snapshot を作って Installer API に `source.kind: prepared` として渡す。

主要 decision (= RFC 0001 §7 resolved):

- **Alias resolution**: operator-injected alias map (= `createPaaSApp({ kindAliases })`) + provider operation 前の fail-closed lookup miss on unresolved short alias
- **worker.spec.entrypoint**: reference worker kind は resolved source snapshot 内の source-root-relative entrypoint を読む。DataAsset は別 workflow で扱う。
- **Build sandbox**: operator build service / CI / automation の責務
- **Official catalog wording**: `https://takosumi.com/kinds/v1/*` は Takosumi official type catalog の descriptor documents。operator は opt-in で Space に公開し、alternative catalog も同じ core contract で扱える
- **JSR package architecture**: `@takos/takosumi-plugins` keep + narrow re-scope (= URL stability 維持、 plugin factory adapter / SDK helper へ scope narrow)
- **runtime-agent kernel-decouple**: 別 RFC 0002 (= 想定) で扱う

詳細 design は [`docs/rfc/0001-kernel-kind-agnostic.md`](docs/rfc/0001-kernel-kind-agnostic.md)。

## 基本方針

- **Source-to-runtime engine 専念**: kernel の責務は `.takosumi.yml` を読んで Installation を作り、 apply ごとに Deployment を記録することに限定する。 workflow / CI / build pipeline / cron / hook は kernel の責務外であり、 operator が別途 orchestrator / build service で実装する。 AppSpec に `component.build` は存在しない。
- **`POST /v1/installations` is the canonical install entry point**: kernel は AppSpec を受ける first-class API を持ち、 CLI / GitHub Actions / 自前 CI / operator script はすべて 5 endpoint を直接叩く構成で動作する必要がある。
- **Public API surface は 5 endpoint だけ**: `POST /v1/installations/dry-run` / `POST /v1/installations` / `POST /v1/installations/{id}/deployments/dry-run` / `POST /v1/installations/{id}/deployments` / `POST /v1/installations/{id}/rollback`。 HTTP status は `failed_precondition` = **409** を apply precondition failure (source pin / prepared digest / expected guard mismatch、required external publication absence、portable に再利用できない local source omit) に使い、 `resource_exhausted` = **413** を request / manifest / source size 超過に限定する。 Idempotency-Key header は v1 surface に含まれない (廃止)。
- **Substitutability で kernel pure を justify**: workflow / identity / billing / project convention は operator / application 側の responsibility として扱い、kernel が Cloudflare Workers / Kubernetes / bare metal / 自前 runtime を越えて移植可能な形を保つ。substitutability で justify できる responsibility だけを kernel に入れる。
- **Runtime neutrality は `shared/runtime/` で集約**: kernel core から `Deno.*` / `process.*` / `node:*` の直接呼び出しは排除済み。全 runtime primitive (env, exit, signal, fs, subprocess, serveHttp) は `packages/kernel/src/shared/runtime/` の `RuntimeAdapter` 経由で呼ぶ。 Deno / Node / Workers / Bun の差分はそこだけで吸収する。新規 code path で `Deno.*` を直接呼ぶ PR は reject。
- **Prepared source model**: build service は command を実行して source tree を準備し、operator build-service profile が定義する source package と `sha256` digest の prepared source snapshot を Installer API に渡す。file path は `worker.spec.entrypoint` のように kind-specific `spec` に置く。
- **Takos 中立**: takos-git / Takos 固有 service ID への直接依存は kernel core から完全に除去済み。
- **Component kind は外部定義**: 新 kind は任意 domain の URI + descriptor metadata + implementation binding で成立する (`CONVENTIONS.md` §6)。 Takosumi official type catalog は reusable descriptor documents を JSON-LD で公開する。Takosumi が `https://takosumi.com/kinds/v1/<name>` で publish する `worker` / `postgres` / `object-store` / `gateway` は official catalog の descriptor URI。short alias は operator が `kindAliases` で opt-in した場合だけ解決される。OIDC は component kind ではなく、Takosumi Accounts が `operator.identity.oidc` external publication path に publish する account-plane material として扱う。
- **Reference implementation binding = operator-attached KernelPlugin**: reference kernel では kind 実装を `KernelPlugin` factory を返す plain array (= Vite plugin pattern, cloud provider package が提供する形式) として attach する。互換実装は同じ kind URI を別 registry / controller / adapter へ bind してよい。
- **Provider / adapter reference bindings は別 package**: AWS / GCP / Cloudflare / Kubernetes / Deno Deploy の provider implementation は `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy}-providers` に分離し、Docker Compose / systemd / MinIO / filesystem / Docker Postgres / CoreDNS のような外部入口 adapter は `@takos/takosumi-plugin-<kind>-<backend>` として publish する。takosumi core (kernel / plugins / cli) は cloud SDK や host-specific SDK に依存しない。operator は必要な package を import して reference kernel の `plugins: [...]` に attach する。
- **credential は operator/runtime-agent 側**: cloud credential / SDK code は runtime-agent host または operator host 側に置き、kernel には `kindAliases` と provider `plugins` だけを渡す。
- **identity / billing は account-plane 側**: per-Installation OIDC client 発行は Takosumi Accounts (operator-owned identity plane) の責務。 Takosumi Accounts は `operator.identity.oidc` external publication path に OIDC client material を publish し、 worker は `listen: { oidc: { from: operator.identity.oidc, as: secret-env, required: true } }` で標準 env (`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS`) を受け取る。sensitive value は secretRef-mediated projection として扱う。
- **implementation binding loading は operator import**: ecosystem trust model は OIDC ID token issuance / signing と opaque install launch token issuance を **Takosumi Accounts** が所有する。reference kernel では provider binding を Vite と同じく operator distribution が TypeScript module として import し、 `createPaaSApp({ plugins })` に attach する。package の取得・検証は operator policy で扱う。詳細は [docs/reference/supply-chain-trust.md](./docs/reference/supply-chain-trust.md)。
- 設計語彙は contract (AppSpec / Component / kind / publish / listen / Installation / Deployment) を優先し、`KernelPlugin` は reference kernel の implementation binding 語彙として使う。

## JSR publish layout

> package version は per-package deno.json と同期する pre-1.0 値で運用する。 public concepts は AppSpec / Installation / Deployment であり、public HTTP contract は Installer API 5 endpoint。「ecosystem 一律 1.0 GA」は宣言しない。

| Package                                             | Version | 内容                                                                                      |
| --------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract`                          | 2.6.0   | public AppSpec / Installer API DTOs; reference/internal APIs live under explicit subpaths |
| `@takos/takosumi-kernel`                            | 0.14.0  | HTTP server + installer pipeline + storage + workers                                      |
| `@takos/takosumi-plugins`                           | 0.12.0  | official catalog helpers + reference adapter helpers                                      |
| `@takos/takosumi-installer`                         | 0.1.0   | .takosumi.yml parser + git fetch + deploy client                                          |
| `@takos/takosumi-runtime-agent`                     | 0.7.0   | kernel ↔ tenant gateway-manifest runtime                                                  |
| `@takos/takosumi-cli`                               | 0.15.0  | CLI (`takosumi install` / `takosumi deploy` 等)                                           |
| `@takos/takosumi-plugin-web-service-docker-compose` | 0.1.0   | Docker Compose `web-service` `KernelPlugin` factory                                       |
| `@takos/takosumi-plugin-web-service-systemd`        | 0.1.0   | systemd `web-service` `KernelPlugin` factory                                              |
| `@takos/takosumi-plugin-object-store-minio`         | 0.1.0   | MinIO `object-store` `KernelPlugin` factory                                               |
| `@takos/takosumi-plugin-object-store-filesystem`    | 0.1.0   | filesystem `object-store` `KernelPlugin` factory                                          |
| `@takos/takosumi-plugin-postgres-docker`            | 0.1.0   | Docker `postgres` `KernelPlugin` factory                                                  |
| `@takos/takosumi-plugin-gateway-coredns`            | 0.1.0   | CoreDNS `gateway` `KernelPlugin` factory                                                  |
| `@takos/takosumi-cloudflare-providers`              | 0.1.0   | Cloudflare (Workers / R2 / DNS) `KernelPlugin` factories                                  |
| `@takos/takosumi-aws-providers`                     | 0.1.0   | AWS (Fargate / S3 / RDS / Route53) `KernelPlugin` factories                               |
| `@takos/takosumi-gcp-providers`                     | 0.1.0   | GCP (Cloud Run / GCS / Cloud SQL) `KernelPlugin` factories                                |
| `@takos/takosumi-kubernetes-providers`              | 0.1.0   | Kubernetes Deployment + Service `KernelPlugin` factory                                    |
| `@takos/takosumi-deno-deploy-providers`             | 0.1.0   | Deno Deploy `KernelPlugin` factory                                                        |
| `@takos/takosumi`                                   | 0.17.0  | umbrella (core 6 つを再公開、 provider packages は別 install)                             |

> Wave J Component contract minimization は contract surface 削減 (= routes / interfaces / permissions 削除) のため breaking だが、策定中 phase なので version bump は次回 publish 直前に collective minor bump として行う (= 現状 deno.json の version は固定維持、 contract / kernel / plugins / cli / all の minor bump を Wave J 完了の announcement 時に同時実施予定)。

> Note: `@takos/` JSR scope は current package distribution の publish scope であり、 authority は publisher ではなく contract (`@takos/takosumi-contract`) の側にある。 contract-compatible な alternative publisher (例: `@example/takosumi-kernel`) は spec 上可能。

## Local / Remote 起点

```bash
# kernel server を起動
deno run -A jsr:@takos/takosumi-kernel

# CLI を install して install する
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi server                                  # in-process kernel
takosumi install --source ./                     # local source
takosumi install --remote https://kernel.example.com \
  --source git:https://github.com/example/notes#main \
  --space space:personal \
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

- **Upstream**: `@takos/takosumi-contract` (型契約のみ、本 workspace の `packages/contract/`)
- **Downstream consumers**: 任意の operator が JSR から install して自分の account-plane / runtime / external systems に接続する
- **Provider / adapter packages**: `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy}-providers` と `@takos/takosumi-plugin-<kind>-<backend>` は本 repo の workspace member であり、各々独立 JSR package として publish される。operator は必要な package だけを import する。
- **Takosumi Accounts (`takosumi-cloud/`)**: identity / billing / OIDC issuer / Installation ledger を保有する operator account plane の reference 実装。 Takosumi Accounts が `operator.identity.oidc` external publication path に OIDC client material を publish し、 worker は `listen` で受け取る。public AppSpec に `oidc` component kind はない。
- **Takos ecosystem**: Takos product distribution は本 repo の上に Takos 固有 deploy package (deploy/distributions/*.json 等) を被せる。これは `takos/` に残る別レイヤー。

## 作業ルール

- 新 cloud provider 追加時は `CONVENTIONS.md` §4 の手順に従う (`packages/<cloud>-providers/src/<kind>-<provider>.ts` 追加 + `mod.ts` re-export + tests)。
- 新 component kind を増やしたい場合は `CONVENTIONS.md` §6 の RFC プロセスに従う (= URI + descriptor metadata + implementation binding を揃える)。 Takosumi official type catalog へ共有する descriptor は JSON-LD で publish する。catalog は external であり、operator-defined kind も受理する。
- kernel 修正は `packages/kernel/` 内で完結させる。 Takos 固有 ID (`takos-app` 等) は再導入しない。
- contract 変更を要する change は `packages/contract/` で coordination する。
- process role 名は `takosumi-{api,worker,router,runtime-agent,log-worker}` で固定。
- AppSpec に `component.build` を再導入しない。 `jobs:` / `steps:` / `matrix:` / `triggers:` / pipeline DSL は BuildSpec / build service / CI の責務。
