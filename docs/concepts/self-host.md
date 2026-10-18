# 自分で動かす

Takosumi は自分の環境に置いて、自分の endpoint として動かせます。ソフトウェアは
AGPL-3.0 で公開しています。利用者が接続する origin に control plane、accounts、dashboard
をまとめます。OpenTofu runner と source/artifact/state の永続化は構成ごとに異なります。
CLI、dashboard、Takoform client とその他の API client は、その origin に向かって話します。

リポジトリの `deploy/` に、置き場所の違う 3 つの雛形が入っています。

## 構成を選ぶ

| 構成と雛形 | plan と apply | 実行環境 | 状態の保存先 |
| --- | --- | --- | --- |
| **Cloudflare**<br>`deploy/platform/` | plan はできます。apply と destroy には release tool が作る digest が要ります（[apply と destroy について](../self-host/cloudflare.md#apply-と-destroy-について)） | Cloudflare Workers | D1 / R2 / Durable Objects |
| **Bun と PostgreSQL**<br>`deploy/node-postgres/` | runner を別に組み込むまでできません | VM やコンテナ | PostgreSQL |
| **手元だけ**<br>`deploy/local-substrate/` | できます（`--profile postgres` で起動する同梱の runner コンテナ） | 手元の Linux と Docker | Docker Compose のボリューム |

**Cloudflare** は、サーバーを自分で持たずに運用したい場合に向きます。Workers Paid プランの
Cloudflare アカウントと、Cloudflare で DNS を管理しているドメインが要ります。OpenTofu の
実行は Cloudflare Container の runner が引き受けます。1 つの Worker に accounts、
control plane、dashboard、runner がまとまります。

**Bun と PostgreSQL** は、自分のインフラに置きたい場合に向きます。Docker が動くホストが
あれば、同梱の `docker-compose.yml` が PostgreSQL、control plane と Accounts のデータベースの
移行（schema migration）、サービス本体、TLS 用 Caddy を起動します。この標準の構成には、
OpenTofu を動かす runner も、その成果物の保存先もありません。制御情報の書き出しと削除前の
書き出し（control / pre-destroy export）は `takosumi-runtime` volume に保存します。Accounts、
control plane、dashboard の確認には使えますが、Git の同期、plan、apply は
`runner_capability_missing` になります。plan と apply には、runner とその保存先を組み込んだ
構成を自分で用意する必要があります。

**手元だけ**の構成は、公開せずに全体を通したい場合に使います。Linux、Docker、Bun と、
証明書と DNS を設定するための `sudo` が要ります。ACME 用の Pebble、CoreDNS、Caddy を
同じ Docker ネットワークに立て、`*.takosumi.test` を本番と同じ形で解決します。

## 費用

Takosumi のソフトウェアに利用料はありません（AGPL-3.0）。かかるのは、Takosumi を置く場所の
料金と、追加したアプリが作るリソースの料金です。

- **Cloudflare** — Workers Paid プランの料金と、Workers、Containers、D1、R2、Durable Objects、
  ログ（observability）の使用量が Cloudflare から請求されます。dashboard の表示も Worker への
  リクエストになります。ほかに、ドメインの費用がかかります。金額は Cloudflare の
  [Workers の料金](https://www.cloudflare.com/plans/developer-platform/)と
  [Containers の料金](https://developers.cloudflare.com/containers/platform/pricing/)で
  確かめてください。

  runner のコンテナ（雛形では 2 vCPU・6 GiB・ディスク 10 GB、最大 10 台）が起動するのは、
  変更の確認・デプロイ・削除、リポジトリの取得、追加前の確認、利用者が依頼した復元・
  バックアップ・安定版タグの確認のときです。自動で同期するリポジトリがあると、毎時の確認でも
  起動します。drift の確認と、更新があるサービスの自動の変更確認は、有効にした場合だけ起動
  します。どれも、その処理が終わるか、約 30 秒操作がないと止まります。
- **Bun と PostgreSQL** — Docker を動かすサーバーと PostgreSQL の費用です。plan と apply には、
  別に組み込む runner の費用もかかります。
- **手元だけ** — Takosumi 自体は、手元のマシンの中だけで動きます。
- **追加したアプリのリソース** — アプリが作る Worker、bucket、データベースなどの料金は、
  接続したアカウントの事業者（Cloudflare など）から、そのアカウントに請求されます。

## 手順

- [Cloudflare に置く](../self-host/cloudflare.md)
- [Bun と PostgreSQL に置く](../self-host/bun-postgres.md)
- 手元だけで通す（下記）

## 手元だけで通す

手元の Linux で、公開面を一切持たずに全体を動かします。

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
bash scripts/smoke.sh
```

`ca-install.sh` はホストの信頼ストアと、Chrome / Firefox の NSS データベースの両方に
Pebble の root CA を入れます。Pebble はコンテナが起動するたびに root を作り直すので、
`down.sh` のあとに `up.sh` で起動し直したときや、ホストを再起動したあとに証明書の
エラーが出たときは、`ca-install.sh` も実行し直してブラウザを再起動します。設定の意味と
元に戻す手順は[クイックスタート](../getting-started/quickstart.md)にあります。

## 動いていることを確かめる

まずプロセスが応答することを見ます。

```bash
curl -s https://takosumi.example.com/healthz
```

次に依存が揃っていることを見ます。Cloudflare 構成の `/readyz` は binding の有無を
点検し、足りないものがあれば名前を挙げて `503` を返します。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://takosumi.example.com/readyz
```

Bun と PostgreSQL の構成の `/readyz` は、`TAKOSUMI_INTERNAL_API_SECRET` が無いと `503` を返し、
理由に `internalApiSecret` を挙げます。同梱の Compose はこの値を渡さず、今はこの確認のほかに
使われていません。`/healthz` が `200` なら、起動時の検査（封印鍵、署名鍵、上流の ID プロバイダの
設定）を通ってプロセスが立ち上がり、PostgreSQL も応答しています。上流の ID プロバイダや
dashboard までは確かめません。`/readyz` も通す方法は
[Bun と PostgreSQL に置く](../self-host/bun-postgres.md#readyz-を通す)にあります。

サインインの土台が立っているかは、OIDC の discovery で見ます。`issuer` に
`TAKOSUMI_ACCOUNTS_ISSUER` と同じ値が返れば正しく設定できています。

```bash
curl -s https://takosumi.example.com/.well-known/openid-configuration
```

この endpoint が何を有効にしているかは、製品の discovery で分かります。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
curl -s https://takosumi.example.com/api/v1/capabilities
```

ここまでが通ったら、実データを 1 回読みます。dashboard でサインインし、
[API キーの作り方](../reference/cli.md#トークンを発行する)に沿って、**読み取り** を付けた API キーを
作ります。作る前に、**現在のワークスペースだけで使用できるようにする** が表示されていたらオフに
します。このキーで Workspace の一覧を取ります。scope は互いを含まないので、`write` だけの token ではこの読み取りが `403` に
なります。使うのは発行した token で、operator 専用の `TAKOSUMI_DEPLOY_CONTROL_TOKEN` では
ありません。作ったキーを環境変数 `TAKOSUMI_READ_TOKEN` に設定して次を実行し、`200` が返れば、
認証と記録の読み取りが通っています。

```bash
curl -s -H "authorization: Bearer $TAKOSUMI_READ_TOKEN" \
  https://takosumi.example.com/api/v1/workspaces
```

最後に、runner を含む構成で実際に 1 回デプロイします。dashboard の `/new` に Git URL を入れて計画を作り、
内容を確認してからデプロイします。Cloudflare 構成で 3 つの digest が無いあいだは、
[apply と destroy について](../self-host/cloudflare.md#apply-と-destroy-について)のとおり、計画の作成までを確かめます。Run が成功し、StateVersion と Output が残れば、runner と
state backend まで通っています。provider の認証を必要としない
`examples/opentofu-basic` が、この確認にちょうど使えます。

## 次に決めること

ここまでで endpoint は動きます。そのうえで、何を使えるようにするかは動かしている側が
決めます。有効にする runner の profile、定期的な確認 1 回で拾う Source の上限、削除の猶予期間、
秘密の保存のしかたなどは、すべて設定で決まります。変数の一覧と決め方は
[設定リファレンス](../reference/configuration.md)にあります。

その endpoint を使う人から見て、あなたがどこまでを引き受けることになるのかは
[製品の境界](./boundaries.md)にまとめてあります。

[運用ガイド](../self-host/index.md)
