# 全体像

Takosumi は、Git にある OpenTofu module を実行し、その結果を台帳として残す
control plane です。インフラそのものは作り直しません。既存の provider を
そのまま実行します。

## 何を担当し、何を担当しないか

**担当するもの** — どの commit を、どの認証情報で、いつ、誰が実行したかの記録。
実行後の状態と、公開された値の管理。誰がその値を使ってよいかの認可。

**担当しないもの** — クラウド API の再実装と module の中身。Cloudflare、AWS、
Kubernetes などは、その provider と標準 API をそのまま使います。Takosumi は
その外側にいます。

## 2 つの作り方

Takosumi には、サービスを作る方法が 2 つあります。

**Stack flow** — 自分で書いた OpenTofu module を Git から実行します。module の
中身は自由で、Takosumi は実行と記録だけを担当します。専用のマニフェストは要りません。

**Resource** — 型が決まったサービスを宣言だけで作ります。どの実装に載せるかは
Takosumi が解決します。module を書かずに済みますが、作れる種類は決まっています。

どちらも同じ Run 台帳、同じ状態管理、同じ監査記録を使います。

## 主な登場人物

| 名前 | 役割 |
| --- | --- |
| Workspace | 人とリソースの入れ物。メンバーと権限の単位 |
| Project | Workspace 内の整理単位 |
| Source | Git リポジトリの登録 |
| SourceSnapshot | Source が解決した特定の commit |
| Capsule | デプロイされた 1 つのまとまり |
| Run | 1 回の実行の記録 |
| StateVersion | 実行後に保存される状態の 1 地点 |
| Output | Capsule が公開する非 secret の値 |
| Connection | 書き込み専用で保存した認証情報 |
| Interface | 実行時に提供する機能の宣言 |
| InterfaceBinding | Interface を使ってよい相手の認可 |

用語の詳しい定義は[用語集](../reference/glossary.md)にあります。

## 変更が反映されるまで

```text
Source を登録する
  → commit を SourceSnapshot として固定する
  → 計画 Run を作る
  → 内容を人が確認する
  → 同じ Run を適用する
  → StateVersion と Output が保存される
```

**計画を挟まずに適用されることはありません。** Git に新しい commit が来ても、
差分が見つかっても、自動では適用されません。

## もっと詳しく

- [Source と Capsule](./sources.md) — Git をどう扱い、何が「デプロイされている」のか
- [実行モデル](./run-model.md) — Run が何をどう実行するか
- [状態と出力](./state-and-outputs.md) — 何が保存され、何が公開され、どう戻すか
- [認証情報](./credentials.md) — 値がどこまで行き、何が記録に残るか
- [Resource](./resources.md) — 型付きサービスと、その解決経路
- [Interface](./interfaces.md) — 提供する機能の宣言と認可
- [利用量と課金](./usage-and-billing.md)
- [製品の境界](./boundaries.md) — ソフトウェアと運用主体の分担
