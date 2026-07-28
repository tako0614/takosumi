# Takosumi とは

Takosumi は、Git に置いた OpenTofu / Terraform の module を、**計画 → 確認 → 反映**の
順に実行し、その履歴を残していく control plane です。
Takosumi は first-party Terraform/OpenTofu provider を同梱しません。

インフラそのものは作りません。Cloudflare や AWS を操作するのは、いつもどおりそれぞれの
provider です。Takosumi が受け持つのは、それを**誰が、いつ、どの認証情報で実行し、
結果どうなったか**を管理する部分です。

## 何が変わるか

`.tf` を書いて `tofu apply` を回している状態から、次のことができるようになります。

**同じ module を、接続先だけ変えて動かせます。** module に認証情報も環境の区別も
書きません。開発用と本番用で Capsule を 2 つ作り、それぞれに別の Connection を
割り当てます。`.tf` は 1 つのままです。

**適用の前に、必ず内容を確認できます。** 計画を作り、その内容を見て、納得してから
**同じ計画を**適用します。適用の直前に計画が作り直されることはないので、確認したものと
違うものが流れる余地がありません。

**あとから追跡できます。** どの commit を、誰が、いつ、どの認証情報で流したかが Run と
して残ります。適用のたびに状態が保存されるので、前の状態にも戻せます。

**認証情報の置き場所が減ります。** 保存した値は読み出せません。渡されるのは実行中の
sandbox だけで、記録に残るのは変数名だけです。

**サービス同士をつなげます。** ある Capsule が公開した値を、別の Capsule から参照
できます。接続先を手でコピーして貼る必要がありません。

## 使うとこうなります

```bash
# 1. リポジトリを登録する
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "workspaceId": "ws_example", "name": "my-app",
        "url": "https://github.com/example/my-app.git",
        "defaultRef": "v1.0.0", "defaultPath": "deploy/opentofu" }'

# 2. 計画を作る
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

# 3. 内容を読んで、納得したら同じ Run を適用する
takosumi status run_example

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/apply" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

画面から進めることもできます。dashboard の `/new` に Git URL を入れると、module を読んで
必要な変数と provider を提示するので、そのまま確認して適用できます。

## module は普通のままで構いません

Takosumi 専用のマニフェストはありません。`.tf` に書き足すものもありません。いま動いて
いる module をそのまま登録できます。

型の決まったサービス (オブジェクト保管、KV、SQL、キューなど) を、module を書かずに宣言
だけで作る経路もあります。こちらは任意で、使わなくても Takosumi は動きます。

## 向いている場面

- 複数人で同じインフラを触っていて、**誰が何をしたか**を残したい
- 開発用と本番用で、**同じ module を接続先だけ変えて**回したい
- 適用の前に**必ず人の確認**を挟みたい
- クラウドの認証情報を、**手元や CI の環境変数に置きたくない**

逆に、1 人で 1 環境だけを触っていて `tofu apply` で足りているなら、無理に挟む必要は
ありません。

## 次に読むもの

はじめてなら[クイックスタート](./getting-started/quickstart.md)から進めてください。
ローカルで起動して、実際に 1 つ動かすところまでを扱っています。

仕組みを知りたい場合は[全体像](./concepts/)から読むと、Source と Capsule、Run、
状態と出力、認証情報の順に一通りつながります。

正確な引数や上限が必要になったら、[API](./reference/api.md)、[CLI](./reference/cli.md)、
[Takoform host API](./reference/takoform-host.md) のリファレンスにまとめてあります。

公式の hosted サービスを使う場合の料金や managed リソースは、
[Takosumi Cloud のドキュメント](https://app.takosumi.com/docs/)に分けています。
