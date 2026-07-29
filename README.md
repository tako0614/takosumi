# Takosumi

English: [README.en.md](README.en.md)

Takosumi は、Git に置いた OpenTofu / Terraform module をチームで安全に実行するための
オープンソースの管理サーバーです。

既存の module と provider をそのまま使い、次の部分を Takosumi が引き受けます。

- 変更内容を `plan` で確認してから、同じ計画を `apply` する
- 実行した commit、実行者、時刻、結果を記録する
- state、output、ログを実行ごとに保存する
- クラウドの認証情報を保管し、実行中の runner にだけ渡す
- Git から取り込んだアプリやインフラを、画面と API から管理する

Takosumi 専用の `.tf` 記法や first-party provider はありません。Cloudflare、AWS、
Kubernetes などは、それぞれの既存 provider が操作します。

[ソフトウェアのドキュメント](https://takosumi.com/docs/) ·
[Takosumi Cloud のドキュメント](https://app.takosumi.com/docs/)

## 5 分で動作を確認する

この短い手順は、開発用の API をメモリ上で起動します。Bun と Git が必要です。

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

別のターミナルから、起動したサーバーが公開している機能を確認します。

```bash
curl http://127.0.0.1:8788/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

これは API の動作確認用です。再起動するとデータは消え、dashboard と OpenTofu runner
も含みません。実際に Git module を plan / apply する手順は
[クイックスタート](docs/getting-started/quickstart.md)にあります。

## デプロイ方法

Takosumi には 2 つの入口があります。どちらも同じ実行履歴、state、output、監査記録を
使います。

### Git の module を実行する

通常はこちらを使います。

1. Git URL、ref、module のパスを登録する
2. Takosumi が ref を 1 つの commit に固定する
3. `plan` を作り、変更内容を確認する
4. 確認した計画を `apply` する
5. state、output、ログ、監査記録を保存する

Takosumi では、登録した 1 つの module を **Capsule** と呼びます。この名前を知らなくても
module 自体を書き換える必要はありません。

repository は任意の `.well-known/takosumi.json` で、同じ commit に固定された
Takosumi 向け metadata を提案できます。現行contractは一般
`Repository` envelopeの `install.modules` だけを定義し、実行authorityは
DB-owned `InstallConfig`、Plan、Runに残ります。詳細は
[Repository manifest](docs/reference/repository-manifest.md)を参照してください。

### 型を指定してリソースを作る

運用者が有効にしている場合は、オブジェクトストレージや SQL データベースなどを
**Resource** として宣言できます。利用者は欲しい種類と設定を書き、配置先と実装は
運用者が用意した候補から選ばれます。

Resource は任意の機能です。使える種類は Takosumi の設置先ごとに異なり、
`/.well-known/takosumi` または `/v1/capabilities` で確認できます。Takoform は
Resource を記述するために利用できる形式の 1 つであり、Takosumi やクラウドそのもの
ではありません。

詳しくは[全体像](docs/concepts/index.md)と
[Resource](docs/concepts/resources.md)を参照してください。

## Takosumi と Takosumi Cloud

- **Takosumi** はこのリポジトリのソフトウェアです。自分の環境で運用できます。
- **Takosumi Cloud** は `app.takosumi.com` で提供する公式ホスティングです。managed
  リソース、料金、容量、サポートは Cloud 側が決めます。

OSS は Cloud がなくても動きます。Cloud 固有の価格、Stripe、内部の配置先はこの
リポジトリの公開仕様ではありません。境界の詳細は
[製品の境界](docs/concepts/boundaries.md)にあります。

Takos は別の製品です。Accounts / deploy-control / dashboard / runner を Takos worker に
組み込みません。Takos は外部 client として Takosumi endpoint に接続します。

## ドキュメント

- [クイックスタート](docs/getting-started/quickstart.md) — dashboard と runner を含むローカル環境
- [全体像](docs/concepts/index.md) — Git module、Resource、Run、state のつながり
- [認証情報](docs/concepts/credentials.md) — provider の接続情報を安全に渡す方法
- [自分で動かす](docs/concepts/self-host.md) — self-host の構成と判断事項
- [Repository manifest](docs/reference/repository-manifest.md) — repository-owned metadata と `InstallConfig` の境界
- [API リファレンス](docs/reference/api.md)
- [CLI リファレンス](docs/reference/cli.md)
- [設定リファレンス](docs/reference/configuration.md)
- [運用手順](docs/operations/README.md)

## 開発

```bash
bun run check
bun test
bun run docs:build
```

主なディレクトリは、公開 contract の `contract/`、control plane の `core/`、画面の
`dashboard/`、runner の `runner/`、配布構成の `deploy/`、ドキュメントの `docs/` です。
standalone OSS clone は hosted Cloud の GA や本番課金の操作を代理実行しません。

ライセンスは [AGPL-3.0-only](LICENSE) です。脆弱性の報告方法は
[SECURITY.md](SECURITY.md)を参照してください。
