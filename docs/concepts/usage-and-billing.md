# 利用量と課金

Takosumi は、何にどれだけ使ったかを記録します。**Takosumi 自体は請求を
行いません。**

## 3 つの粒度で読めます

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/usage" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/usage-summary" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/cost" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Workspace の利用量は明細の一覧として返り、1 件ごとに何の量か、どれだけか、いつの
ものか、どの Resource に属するかが入ります。Capsule 単位の集計は「どのアプリが
どれだけ使ったか」を見るためのものです。Run の費用見込みは**適用する前に**読めます。

## 課金モード

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/billing" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Takosumi が持つモードは 2 つだけです。

| モード | 意味 |
| --- | --- |
| `disabled` | 記録も請求もしない |
| `showback` | 記録するが請求しない |

**請求を伴う運用はソフトウェアの機能ではありません。** 残高で実行を止める、価格表を
持つ、支払い手段と照合するといった動作は、この層にはありません。Takosumi Hosted の
retail/commerce と Takoserver の managed supply は、それぞれの owner が料金、上限、
支払い契約を公開します。退役した Takosumi Cloud 文書は現行料金の正本ではありません
([製品の境界](./boundaries.md))。

self-host している場合、利用量の記録はあくまで自分のための可視化です。

## 関連

- [実行モデル](./run-model.md)
- [製品の境界](./boundaries.md)
