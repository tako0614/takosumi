# API だけ動かす

開発中に API を確かめるための、最小の起動手順です。必要なものは Bun と Git です。
`DATABASE_URL` などのデータベース設定がなければ、データはメモリ上に置かれ、再起動すると
消えます。dashboard と runner は起動しません。

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

別のターミナルから確認します。

```bash
curl http://127.0.0.1:8788/api/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

JSON が返れば API は動いています。

dashboard、サインイン、runner まで含めて試すときは[クイックスタート](./quickstart.md)を、
production で運用するときは[自分で動かす](../concepts/self-host.md)を参照してください。
