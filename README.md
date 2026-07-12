# Takosumi

English: [README.en.md](README.en.md)

Takosumi は、Git に置いた OpenTofu/Terraform module を、計画 → 確認 → 反映の流れで安全にデプロイ・管理する
OSS の基盤ソフトウェア (control plane) です。普通の OpenTofu/Terraform module をそのまま実行でき、専用の
設定ファイルや独自言語は要りません。

できること:

- Git URL から module を取り込み、アプリやインフラとして登録する (Capsule)
- クラウドの認証情報を安全に保管し、実行中だけ環境変数やファイルとして渡す (ProviderConnection)
- 反映する前に変更内容を確認し、承認してから反映する (plan / apply の Run)
- 変更のたびに状態を保存し、いつ誰が何を変えたかを記録する (StateVersion / AuditEvent)
- アプリが公開する URL などの値を記録し、別のアプリの入力につなぐ (Output)

Software docs: <https://takosumi.com/docs/>
Hosted Cloud docs: <https://app.takosumi.com/docs/>

## 始め方 (ローカル control plane)

curl やテストから `/api/v1` contract を触りたい場合は、ローカルで control-plane service を直接起動します。

```bash
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
PORT=8788 bun core/index.ts
```

標準の使い方は、dashboard で Git URL を指定して install し、Git Source から Capsule を作る流れです。dashboard の
install / plan / apply は、登録済みの Git Source に対して [`/api`](docs/reference/deploy-control-api.md)
control plane を通ります。アプリのソース、ビルド成果物、コンテナイメージ、release artifact は Git に置いた
OpenTofu module とその普通の変数で表現し、Takosumi 側に独自の upload / build 経路は持ちません。CLI は
[docs/reference/cli.md](docs/reference/cli.md) にまとめています。廃止済みの `takosumi deploy` / `takosumi plan`
(ローカル upload 経路) は安全側に停止し、公開 Capsule を作りません。

## 仕組み

Takosumi はひとつの OSS ですが、handler は `tsconfig` alias を通して host worker に **in-process** で組み込まれ、
2 つの構成で使われます。

- operator が運用する Takosumi platform worker (`app.takosumi.com`)
- self-host された Takos distribution worker (Takos product surface が、自分の origin で accounts /
  deploy-control / dashboard / runner を組み込む)

これは組み込みの仕組みであって、別々の製品ではありません。npm で配布する service package もありません。
`takosumi.com` は landing / software docs のサイトです。

### In-process entry points

| Handler        | File                                                                   | Mount                                                                               |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Account plane  | `deploy/accounts-cloudflare/src/handler.ts` (`createAccountsHandler`)  | platform worker または takos worker の origin root。issuer は素の origin            |
| Deploy control | `worker/src/handler.ts`                                                | platform worker では `/api`。takos worker では typed な in-process operations seam |

`/install?git=...&ref=...&path=...` は dashboard SPA の入口であって、deploy-control の handler ではありません。
SPA は query を保持したまま `/new` に転送して Git form に値を入れるだけで、互換性チェックと明示的な確認は
`/new` の中で行われます。

`deploy/accounts-cloudflare/` は account-plane の状態を D1 に保存します。Capsule の backup / export 成果物は
deploy-control 側の backup / export flow とその R2 バケットに属し、account-plane の持ち物ではありません。
Cloudflare Container は account-plane では使わず、deploy-control の runner が OpenTofu `plan` / `apply` に使います。

`deploy/node-postgres/` は、local-substrate の cloud profile で同じ `createAccountsHandler` を支える
Bun + Postgres の実行基盤です (`deploy/local-substrate/` の cloud wrapper がその server を import します)。
ひとつの handler の下にある実行基盤であって、別の配布物ではありません。

## 公開モデル

使い方の流れは意図的に小さくしています: **Workspace** と **Project** を選び、Git **Source** を登録して
**Capsule** を作り、**ProviderConnection** / **CredentialRecipe** / **ProviderBinding** で provider を接続し、
**Run** を確認して、**StateVersion** / **Output** / **AuditEvent** を見る。現在のモデルは
[AGENTS.md](AGENTS.md) の "Public Surface" と [docs/internal/final-plan.md](docs/internal/final-plan.md) を
参照してください。用語のひとこと説明は [用語集](docs/reference/glossary.md) にあります。

| 用語                 | 意味                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `Workspace`          | ユーザー / チームの境界。プロジェクト、接続、シークレット、状態、監査がこの中で分離されます     |
| `Project`            | 1 つの製品・サービス・インフラのまとまり                                                         |
| `Capsule`            | 1 つの OpenTofu/Terraform module の実行単位。ふつうは Git URL + ref + path から取り込みます      |
| `Source`             | Git URL / ブランチ / ref / commit / module path。upload 系の取り込みは内部 / operator 互換のみ   |
| `ProviderConnection` | 保管された provider の認証情報。Run の実行中だけ一時的な env / file として解決されます           |
| `CredentialRecipe`   | その provider を動かすための env / file / 事前処理の定義                                         |
| `ProviderBinding`    | provider (と alias) にどの接続を使うかの対応付け                                                 |
| `Secret`             | 暗号化された秘密の値。API からは書き込み専用で、ログには出ません                                 |
| `Run`                | init / validate / plan / apply / destroy / refresh / output の 1 回の実行記録                    |
| `StateVersion`       | 保存された Capsule state の世代                                                                  |
| `Output`             | `tofu output -json` で取り出した値。別の Capsule の入力にもつなげます                            |
| `Runner`             | checkout、OpenTofu 実行、state 同期、output 取得、後片付けを行う隔離された実行境界               |
| `AuditEvent`         | 誰が・何を・どうしたかの証跡                                                                     |
| `Operator`           | Takosumi を自分のユーザーのために運用する人・組織                                                |

旧 Space / Installation / Deployment / OutputSnapshot / `takos_provided` などの言葉は、移行メモや内部実装名に
残ることはあっても、現在の公開モデルではありません。

Takosumi は OpenTofu / Terraform provider を置き換えません。既存 provider はそのまま動き、Takosumi はその外側で
確認・記録できる管理層を提供します。OSS は Resource Shape API、Compatibility API framework、Adapter system を
持ちます。公式 managed target pool、Takosumi 自社リソースの内部実装、強制課金、support / SLA、公式 resource
backend は Takosumi for Operator / Takosumi Cloud 側にあります。

## エディション

| Edition                   | 内容                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Takosumi OSS**          | この repo。Git を起点にした OpenTofu/Terraform control plane、Resource Shape API、Compatibility API framework、Adapter system、接続管理、runner、状態 / 出力 / 監査。課金は disabled / showback のみで apply を止めません |
| **Takosumi for Operator** | Takosumi を顧客向けにホストする operator 向けエディション。マルチテナントの顧客管理、quota / metering / プラン、DB 管理の operator 設定、CLI / API / runbook 運用、managed target catalog、サポート、商用監査          |
| **Takosumi Cloud**        | `app.takosumi.com` で私たちが運営する公式ホスティング。公式 managed targets、Takosumi 自社リソース、AI Gateway、Stripe による課金、quota、usage、support、abuse controls、SLA                                        |

依存方向は **Cloud -> OSS の一方向**です。hosted Cloud は OSS の contract と組み込み口だけを使い、OSS は
Cloud のものが何もなくてもそのまま動きます。

## リポジトリ構成

現在の構成は `contract/`、`core/`、`lib/`、`accounts/`、`providers/`、`worker/`、`runner/`、
`opentofu-modules/`、`dashboard/`、`website/`、`deploy/` です。注釈付きのツリーは
[AGENTS.md](AGENTS.md) の "Workspace" 節を参照してください (二重管理を避けるため、そちらを正とします)。

## コマンド

```bash
bun run check
bun test
bun run test:scripts
bun run docs:build
bun run app-docs:build
bun run website:build
```

## Docs と website

`docs/` は `takosumi.com/docs/` に出す VitePress の software docs です。`app-docs/` は
`app.takosumi.com/docs/` 用の hosted Cloud docs で、`dashboard/dist/docs/` に埋め込まれます。`website/` は
landing page です。`bun run website:build` で landing page と software `/docs/` を含むひとつの
Cloudflare Pages artifact ができます。
