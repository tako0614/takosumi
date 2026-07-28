# クイックスタート

手元の Linux マシンに Takosumi を 1 つ立ち上げて、Git に置いた OpenTofu module を
1 つ取り込み、plan から apply まで通します。初回は Docker イメージのビルドがあるので
30 分ほど見ておいてください。2 回目からは数分で起動します。

終わったときには、次のものが手元にあります。

- `https://app.takosumi.test` でサインインできる Takosumi が動いています。サインインを
  受け付ける発行元、control plane、dashboard、OpenTofu を実行する runner が同じ origin に
  そろっています
- Git URL から作った [Capsule](../reference/glossary.md) (デプロイされたひとまとまり) が
  1 つできます。plan と apply の記録も残ります
- Git URL を自分のリポジトリに差し替えれば、そのまま同じ手順を試せます

## 前提

- Linux であること。DNS に systemd-resolved、コンテナに Docker daemon を使います。
  macOS、WSL、Windows では動きません
- Docker と `docker compose`
- Bun
- Git
- `curl` と `python3`。起動の確認と、手順 7 の確認スクリプトが使います
- sudo が使えること。証明書と DNS の設定をホストに 1 度だけ入れます

## 1. リポジトリを取得する

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install
```

ディレクトリ名は `takosumi` のままにします。次の手順で使う compose ファイルが、この
名前でリポジトリを参照します。

## 2. ローカルの Takosumi を起動する

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
```

このコマンドは、必要なものを 1 つの Docker network にまとめて立ち上げます。ローカル
認証局の Pebble、DNS を返す CoreDNS、TLS を終端する Caddy、Postgres、オブジェクト
ストレージの MinIO、OpenTofu を実行する runner コンテナ、control plane と dashboard
です。初回はここでイメージのビルドと dashboard のビルドが走ります。起動が終わると、
次に打つコマンドと確認用の URL が画面に出ます。

Docker が既定の AppArmor プロファイルではコンテナを起動できないホストもあります。その
場合は環境変数を付けて実行します。

```bash
TAKOSUMI_LOCAL_SUBSTRATE_DISABLE_APPARMOR=1 bash scripts/up.sh --profile postgres
```

## 3. 証明書と DNS をホストに入れる

```bash
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
```

`ca-install.sh` は Pebble が発行したルート証明書を、システムの信頼ストアと
Chrome / Firefox の証明書データベースに入れます。`configure-dns.sh` は
`*.takosumi.test` の問い合わせを CoreDNS に向けます。どちらもホストごとに 1 回で
済みます。Pebble を再起動するとルート証明書が変わるので、そのときは
`ca-install.sh` をもう一度実行します。

## 4. 起動を確かめる

```bash
curl https://hello.takosumi.test/
curl https://app.takosumi.test/healthz
curl https://app.takosumi.test/.well-known/openid-configuration
```

`/healthz` が `{"ok":true,"database":"ok"}` を返せば、control plane が Postgres まで
届いています。`/.well-known/openid-configuration` が返れば、サインインを受け付ける発行元が
立ち上がっています。

## 5. サインインする

ブラウザで `https://app.takosumi.test/` を開きます。サインイン画面に「Local OIDC」が
出るので、これを選びます。このスタックに同梱されている確認用の ID プロバイダなので、
実在のアカウントは要りません。

## 6. module を 1 つ反映する

サインインしたまま、次の URL を開きます。

```text
https://app.takosumi.test/install?git=https://github.com/tako0614/takosumi.git&ref=main&path=examples/opentofu-basic
```

`/install` は Git URL、ref、module のパスを `/new` の入力欄に入れるところまでを行います。
リンクを開いただけでは何も作られません。画面に取得元、バージョン、フォルダが出るので、
内容を見てから「サービスを追加」を押します。

押したあとは Takosumi が続けます。指定した ref を commit に解決して固定し、module を
読んで互換性を確認し、Capsule を作り、plan を作ります。plan が成功して、承認の設定も
削除される予定のリソースもなければ、そのまま apply まで進みます。承認を設定した
Capsule や、削除を含む plan の場合は、Run の画面が plan の内容を見せて止まるので、
そこで読んでから自分でデプロイします。

`examples/opentofu-basic` は provider を持たず、外部のリソースも作らない module です。
クラウドの認証情報を 1 つも用意せずに、plan、apply、状態の保存までを通せます。

## 7. 成功したことを確かめる

`https://app.takosumi.test/runs` を開くと、いま作った plan と apply の Run が並びます。
どちらも成功で終わっていれば、Git に置いた module がこの Takosumi を通って反映された
ということです。Capsule の詳細画面には、apply を終えた時点の状態 (StateVersion) が
apply のたびに 1 つずつ積み上がります。

スタック全体をまとめて確かめる場合は、同梱の確認スクリプトを実行します。どの構成を
確かめるかは環境変数で伝えます。付け忘れると `workers` 構成として実行され、起動して
いないコンテナを見に行って失敗します。

```bash
TAKOSUMI_LOCAL_SUBSTRATE_PROFILE=postgres bash scripts/smoke.sh
```

最後の行に `==> <件数> passed, 0 failed` と出れば成功です。サインイン、plan と apply、
Run の記録の読み出し、オブジェクトストレージ、DNS と TLS まで通っています。失敗した
チェックのログは `/tmp/smoke-logs/` に残ります。

## 8. 片付ける

```bash
bash scripts/down.sh
```

Postgres の中身や発行済みの証明書も消す場合は `bash scripts/down.sh -v` を実行します。

## 次に読むもの

- [全体像](../concepts/index.md) — Source から Run、状態と出力までのつながり
- [Source と Capsule](../concepts/sources.md) — 自分のリポジトリを登録する
- [認証情報](../concepts/credentials.md) — provider の認証情報を渡す
- [CLI](../reference/cli.md) — 画面での操作を自動化する

公式の hosted サービスを使う場合は、[Takosumi Cloud のドキュメント](https://app.takosumi.com/docs/)を参照してください。
