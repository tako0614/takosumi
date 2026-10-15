# クイックスタート

Linux マシン上にローカルの Takosumi を起動し、サンプルの Git module で plan と apply を
実行します。サンプルは外部リソースを作らないため、クラウドの認証情報は要りません。
初回はコンテナと dashboard をビルドするため時間がかかります。

dashboard や runner なしで API だけ確認する場合は、docs トップの
[API だけ動かす](../index.md#api-only)の手順を使います。

## 必要なもの

- Linux。macOS、WSL、Windows はこの構成の対象外です
- Docker と `docker compose`
- Bun、Git、`curl`、`python3`
- 証明書と DNS を設定するための `sudo`

## 1. リポジトリを取得する

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install
```

コンテナはこのチェックアウトと、そこへ install した依存をそのまま使います。mount する
ディレクトリは名前 `takosumi` (`git clone` の既定名) で決まります。既に別の名前で取得済みの
場合は、ディレクトリ名を `takosumi` に変えてから続けてください。名前が違うと、隣にある
別の `takosumi` ディレクトリが mount されることがあります。

## 2. 環境を起動する

リポジトリのルートから次を実行します。

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
```

このコマンドは Postgres、オブジェクトストレージ、runner、control plane、dashboard、
ローカル認証局と DNS をまとめて起動します。既定の AppArmor 設定でコンテナを起動
できないホストでは、次を使います。

```bash
TAKOSUMI_LOCAL_SUBSTRATE_DISABLE_APPARMOR=1 \
bash scripts/up.sh --profile postgres
```

## 3. ローカル証明書と DNS を設定する

ここから先のコマンドは、`deploy/local-substrate` で実行します。

```bash
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
```

この 2 つはホストごとに 1 回だけ実行します。ローカル認証局を作り直した場合は
`ca-install.sh` をもう一度実行してください。

## 4. 起動を確認する

```bash
curl https://app.takosumi.test/healthz
curl https://app.takosumi.test/.well-known/openid-configuration
```

`/healthz` が `{"ok":true,"database":"ok"}` を返せば、アプリから Postgres まで
接続できています。

## 5. サインインする

ブラウザで `https://app.takosumi.test/` を開き、**Local OIDC** を選びます。これは
ローカル確認用の ID provider なので、実在のアカウントは必要ありません。

## 6. サンプルを追加する

サインインしたまま、次の URL を開きます。

```text
https://app.takosumi.test/install?git=https://github.com/tako0614/takosumi.git&ref=main&path=examples/opentofu-basic
```

追加は、入力済みの画面、**サービスを設定**、**追加前の確認** の 3 画面で進みます。

最初の画面ではサービス名が入力され、Git URL、ref、module path は折りたたまれた
**取得元の詳細** に入っています。リンクを開いただけでは何も作成されません。サービス名を
確認して **追加** を押すと、Takosumi は ref を commit に固定し、module を調べます。

このサンプルは入力項目 **名前** と **公開URLの例** を持つため、次に **サービスを設定** が
表示されます。どちらも省略できます。空欄のまま **続ける** を押すと module の既定値が
使われ、デプロイ前の変更内容（plan）が作られます。

準備が終わると **追加前の確認** に、作成・変更・削除されるリソースの数が表示されます。
このサンプルは provider を使わず、外部リソースも作らないため、クラウドの認証情報なしで
runner、plan、apply、state 保存まで確認できます。内容を確認して **追加する** を押すと
apply が始まります。

リソースの削除・置き換え・import を含む変更では、先に **この変更を承認** を押し、
**変更内容を確認しました** にチェックしてから **追加する** を押します。このサンプルの
最初の追加では表示されません。ポリシーや料金の条件で進められない変更は
**この変更はデプロイできません** と表示され、**技術的な詳細** から Run を開けます。

完了すると **追加できました** と表示され、**サービスを開く** から追加したワークロード
（Capsule）を開けます。通常の更新、drift の検出、Git の新しい commit は勝手に apply
されません。

## 7. 結果を見る

`https://app.takosumi.test/runs` で plan と apply の記録を確認します。Capsule の詳細には
適用後の state が版ごとに保存されます。

環境全体を検査する場合は、リポジトリ同梱の smoke test を使います。

```bash
TAKOSUMI_LOCAL_SUBSTRATE_PROFILE=postgres bash scripts/smoke.sh
```

最後に `0 failed` と表示されれば、サインイン、Run、保存先、DNS、TLS まで通っています。
失敗した検査のログは `/tmp/smoke-logs/` に残ります。

## 8. 停止する

```bash
bash scripts/down.sh
```

Postgres のデータと証明書も消す場合は `bash scripts/down.sh -v` を使います。

## 次に読むもの

- [仕組みの全体像](../concepts/index.md)
- [Source と Capsule](../concepts/sources.md)
- [認証情報](../concepts/credentials.md)
- [自分で動かす](../concepts/self-host.md)
- [CLI](../reference/cli.md)

公式ホスティングを使う場合は
[Takosumi hosted service のドキュメント](https://app.takosumi.com/docs/)を参照してください。
