# Resource

Resource は、OpenTofu module を書かずに作れる型付きのサービスです。「何が欲しいか」
だけを宣言し、どこにどの実装で作るかは Takosumi が解決します。

Stack flow (自分の module を実行する経路) とは入口が違うだけで、同じ Run 台帳、
同じ状態管理、同じ監査記録を使います。

## 使える型は endpoint ごとに決まります

Takosumi core は、既定では Resource の種類を 1 つも受け付けません。その endpoint を
運用している主体が、扱える型を明示的に導入し、さらにその中から新規作成と変更を許す
型を選びます。

そのため **endpoint によって使える型が違います**。確認する方法は 2 つです。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi

takosumi form-availability list --space prod
```

いったん導入された型が書き込み禁止になっても、既存の Resource の読み取り、差分確認、
削除は続けられます。

## 宣言の形

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "ObjectBucket",
  "metadata": {
    "name": "assets",
    "space": "prod"
  },
  "spec": {
    "name": "assets",
    "storageClass": "standard"
  }
}
```

`spec` はあるべき状態、`status` は Takosumi が観測した状態です。`status` は自分で
書きません。パスの名前、`metadata.name`、`spec.name` は一致している必要があり、
食い違うと `400` でどこが違うかが返ります。

## 適用は 2 段階です

```bash
takosumi resources preview --file bucket.json
takosumi resources apply ObjectBucket assets --file bucket.json --yes
```

`apply` は必ず内部で `preview` を先に実行します。表示された内容と実際に適用される
内容は同じものです。`--yes` を付けずに実行すると、内容を表示して**終了コード 2 で
止まります**。確認してから付け直す、という 2 段階を意図した設計です。

## 解決は固定されます

```text
Resource の宣言
  → 使える型か (導入済みか、書き込み可か)
  → 配置先の候補 (TargetPool)
  → 実装の候補 (Adapter)
  → 解決を固定する (ResolutionLock)
  → 実物を作る (NativeResource)
  → 状態と Output を公開する
```

一度解決すると、その Resource の配置先と実装は ResolutionLock として固定されます。
以降の差分確認や refresh は**固定された配置先と実装をそのまま使います**。裏で別の
実装に移されて挙動が変わることはありません。

## 状態を読む

```bash
takosumi resources get ObjectBucket assets --space prod
takosumi resources list --space prod
takosumi resources events ObjectBucket assets --space prod
```

イベントは新しい順に返り、Resource を削除したあとも監査履歴として読めます。
イベントに認証情報、生のエラー、spec、state、Output の値は含まれません。

一覧は `createdAt` と id による keyset 方式です。最終ページ以外では `nextCursor` が
返るので、中身を解釈せず次の `--cursor` にそのまま渡します。既定は 100 件、最大も
100 件です。

## 観測と refresh

```bash
takosumi resources observe ObjectBucket assets --space prod
takosumi resources refresh ObjectBucket assets --space prod
```

`observe` は読み取り専用の差分確認です。差分が見つかっても自動では適用されません。
`refresh` は外部の実物を変更せず、Takosumi 側の状態と Output を更新し、成功した
ときだけ関連する Interface の版を解決し直します。

有効な型を持つ endpoint では、Ready な Resource を古い順に定期観測します。これも
読み取り専用で、観測中に適用や削除が進んだ場合は古い結果で状態を上書きしません。
頻度と並列数は運用主体が設定します。

## 既存の実物を取り込む

```bash
takosumi resources import ObjectBucket assets --file import.json
```

ファイルには通常の宣言に加えて、最上位に `nativeId` を入れます。`nativeId` は
provider が付けている識別子であって**認証情報ではありません**。秘密を渡さないで
ください。

取り込みは、計画に「取り込み 1 件だけ」が含まれ、作成・更新・削除が 1 件も含まれない
場合にだけ適用されます。

## Takoform host API との関係

Takosumi が有効にした Takoform host API は、この仕組みの portable な入口です。
Takoform の Form と Resource 要求を canonical Resource に変換し、同じ lifecycle
ledger を使います。Takosumi 固有の Terraform provider や二重の state はありません。

## 関連

- [Interface](./interfaces.md)
- [実行モデル](./run-model.md)
