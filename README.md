# Takosumi

English: [README.en.md](README.en.md)

Takosumi は、Git に置いた OpenTofu / Terraform のソフトウェアを、接続したクラウドへ
アプリのように追加して使うための、オープンソースの管理サーバーです。追加や更新の前に、
作られるものと変わるものを確かめてからデプロイできます。

使う module と provider はそのままで、Takosumi 専用の設定言語や first-party provider は
ありません。Cloudflare、AWS、Kubernetes などは、それぞれの既存 provider が操作します。

[ソフトウェアのドキュメント](https://takosumi.com/docs/) ·
[Takosumi hosted service のドキュメント](https://app.takosumi.com/docs/)

## できること

- **選んで追加する** — ストアのサービスや Git URL を選び、必要な接続と設定を入れて追加します。
- **デプロイする前に確かめる** — 作成・変更・削除されるリソースの数を見てからデプロイします。
  削除・置き換え・import を含む変更は、承認するまで進みません。
- **鍵を module に書かない** — クラウドの API key や token は Takosumi に保存します。
  値は読み戻せず、変更の確認やデプロイを実行している間だけ runner に渡ります。
- **記録を残し、戻せる** — 誰がどの commit をデプロイし、何が変わったかを記録します。
  デプロイごとの state を版として output とともに残し、以前の版の取得元に戻す変更も、
  確認してから適用できます。

## 始め方

- **公式ホスティングで使う** — [app.takosumi.com](https://app.takosumi.com/) にサインインします。
  公式ホスティング（Takosumi hosted service）は正式提供前（Pre-GA）です。手順、料金、提供状況、
  サポートは[公式ホスティングのドキュメント](https://app.takosumi.com/docs/)にあります。
- **手元で追加からデプロイまで試す** — [クイックスタート](docs/getting-started/quickstart.md)
  に従い、Linux と Docker で dashboard、サインイン、データベース、runner を起動します。
  ローカル証明書と DNS の設定に `sudo` を使います。サンプルは外部リソースを作らないため、
  クラウドの認証情報は要りません。
- **自分の環境で運用する** — [自分で動かす](docs/concepts/self-host.md)で構成を選びます。
  Cloudflare の雛形は runner を含みます。Bun と PostgreSQL の雛形で plan と apply を
  実行するには、runner を別に組み込みます。
- **API だけ動かす** — 開発中の API 確認用に、[API だけ動かす](docs/getting-started/api-only.md)
  の手順で、Bun と Git だけでメモリ上の API サーバーを起動します。

## 仕組み

dashboard では、ストアで選んで追加するものを **サービス** と呼び、追加したサービスは
**ワークロード** の一覧に並びます。ホームから開く、サービス自身の画面は **アプリ** です。
docs と API では、追加したサービスを **Capsule** と呼びます。デプロイの 1 単位で、
Git URL・ref・module path と、変数・接続をまとめたものです。Takosumi は ref を 1 つの commit に固定し、Capsule への変更を、
変更の確認（plan）とデプロイ（apply）の別々の Run として記録します。apply の Run は確認した
plan の Run に固定されるため、読んだ差分と実際にデプロイする差分が一致します。

repository は任意で `.well-known/takosumi.json` を置き、同じ commit の scan で見つかった
module に、Takosumi 向けの情報を添えられます。manifest は module を作ったり選んだりできず、
実行の権限は DB が持つ `InstallConfig`、Plan、Run にあります
（[Repository manifest](docs/reference/repository-manifest.md)）。

Takoform は `registry.terraform.io/tako0614/takoform` からインストールする、ほかと同じ
provider です。Takoform の Form 定義や、Form をホストして実体化するサービスは、この
リポジトリの所有物ではありません。過去の試作にあった `/v1/resources`、Resource Shape、
Form Host、TargetPool、SpacePolicy の API と画面は、現在のソフトウェアの機能ではありません。
互換用に残る API、schema、保存データは移行用の内部実装で、利用手順や画面のナビゲーションには
載せません。

## Takosumi と Takosumi hosted service

- **Takosumi** はこのリポジトリのソフトウェアです。自分の環境で運用できます。
- **Takosumi hosted service** は `app.takosumi.com` で提供する公式ホスティングです。hosted
  Form/service、料金、容量、サポートは hosted service 側が決めます。

OSS は hosted service がなくても動きます。hosted service 固有の価格、Stripe、内部の配置先はこの
リポジトリの公開仕様ではありません。境界の詳細は
[製品の境界](docs/concepts/boundaries.md)にあります。

Takos は別の製品です。Accounts / deploy-control / dashboard / runner を Takos worker に
組み込みません。Takos は外部 client として Takosumi endpoint に接続します。

## ドキュメント

- [クイックスタート](docs/getting-started/quickstart.md) — dashboard と runner を含むローカル環境
- [全体像](docs/concepts/index.md) — Git module、Run、state、Interface のつながり
- [認証情報](docs/concepts/credentials.md) — provider の接続情報を安全に渡す方法
- [自分で動かす](docs/concepts/self-host.md) — self-host の構成と判断事項
- [Repository manifest](docs/reference/repository-manifest.md) — repository-owned metadata と `InstallConfig` の境界
- [API リファレンス](docs/reference/api.md)
- [CLI リファレンス](docs/reference/cli.md)
- [設定リファレンス](docs/reference/configuration.md)
- [運用手順](docs/operations/README.md)
- [公開プロパティの deploy runbook](DEPLOY.md) — この repo の operator が持つ hosted 面の手順

## 開発

```bash
bun run check
bun test
bun run docs:build
```

主なディレクトリは、公開 contract の `contract/`、control plane の `core/`、画面の
`dashboard/`、runner の `runner/`、配布構成の `deploy/`、ドキュメントの `docs/` です。
standalone OSS clone は Takosumi hosted service の GA や本番課金の操作を代理実行しません。

ライセンスは [AGPL-3.0-only](LICENSE) です。脆弱性の報告方法は
[SECURITY.md](SECURITY.md)を参照してください。
