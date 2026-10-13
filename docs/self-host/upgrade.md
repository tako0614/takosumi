# 更新する

更新する commit、両データベースの migration、runner の互換性を先に確認します。
マイグレーションは forward-only です。コードを戻せるかどうかは、その版が更新後の
スキーマを受け入れるかで決まり、列の追加だけでも安全とは限りません。

## Bun と PostgreSQL

[配布構成の README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)
に従って、backup を保全し、新しい checkout からイメージを build します。
旧 accounts サービスを停止してから `migrations` を一度実行し、成功後に新しいサービスを起動します。
Compose の `migrations` は Accounts と control plane の両 schema を扱います。
既存 DB に対して新旧サービスを同時に動かしたまま schema を変更しません。

この配布構成に OpenTofu runner は同梱されません。独自に組み込む場合は、Worker/サービスと
runner の protocol が一致することを確認します。更新後はサインイン、既存 Capsule/Run の読み取り、
認証情報を使う操作を自分の検証 Workspace で確認してください。

## Cloudflare

Accounts D1 と control D1 の schema は別の owner surface です。デプロイ前にそれぞれの
plan、backup evidence、適用手順を確認します。control D1 は
[Control D1 schema predeploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/control-d1-schema-predeploy.md)、Worker は
[platform worker deploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/platform-worker-deploy.md)を参照してください。
リクエストによる schema bootstrap を既存環境の更新手順として扱いません。

## 失敗した場合

schema に触れる前の失敗と、触れた後の失敗を分けて記録します。後者では fence と実行記録を
保持し、適用済み schema を検証して前方修復します。前の Worker Version やイメージがあるだけでは
データベースとの互換性は証明できません。自動の down migration や blind retry は行いません。
