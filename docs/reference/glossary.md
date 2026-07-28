# 用語集

Takosumi のドキュメントに出てくる言葉を、1 語ずつ短く説明します。動きの説明は右端の
ページにあります。

## 画面の言葉と内部の言葉

dashboard は内部の用語をそのまま出さず、次の言葉を使います。API やこのドキュメントで
別の名前を見かけたときは、この対応で読み替えてください。

| 画面の言葉 | 内部の用語 | 指しているもの |
| --- | --- | --- |
| サービス / アプリ | Capsule | デプロイされたひとまとまりです。 |
| 接続済みアカウント | ProviderConnection / ProviderBinding | 保存した認証情報と、その割り当てです。 |
| 変更内容 | plan | 反映する前に確認する変更の一覧です。 |
| 変更内容の検証 ID | planDigest | 確認した計画と適用する計画が同じだと確かめる値です。 |
| 更新履歴 | Run の一覧 | いつ何を流したかが並びます。 |
| 操作履歴 | Activity / AuditEvent | 誰がいつ何をしたかが並びます。 |
| この状態に戻す | StateVersion からの復元 | 過去の状態を選び直す操作です。 |

## 全体の骨組み

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| Takosumi | Git に置いた OpenTofu / Terraform の module を、計画・確認・反映の順に実行して履歴を残す control plane です。 | [Takosumi とは](../index.md) |
| OpenTofu | インフラをコードで定義して適用するオープンソースのツールです。Terraform と互換があります。 | [Takosumi とは](../index.md) |
| Workspace | 人とリソースをまとめる境界です。メンバー、権限、接続、履歴がこの中で分かれます。 | [全体像](../concepts/index.md) |
| Project | Workspace の中を整理するための区分です。 | [全体像](../concepts/index.md) |
| Source | どのリポジトリの、どのディレクトリを、どの ref で追うかという登録です。 | [Source と Capsule](../concepts/sources.md) |
| SourceSnapshot | Source が ref を解決した結果の commit です。実行されるのはいつもこちらです。 | [Source と Capsule](../concepts/sources.md) |
| Capsule | デプロイされたひとまとまりです。OpenTofu の root module 1 つ分が動きます。 | [Source と Capsule](../concepts/sources.md) |
| stale | 追いかけている Source に新しい commit が来た Capsule の状態です。 | [Source と Capsule](../concepts/sources.md) |
| Stack flow | 自分で書いた module を Git から実行する経路です。 | [全体像](../concepts/index.md) |
| 互換性レポート | 登録した module を読み取り専用で解析し、必要な変数と provider を示した結果です。 | [Source と Capsule](../concepts/sources.md) |
| 依存 (Dependency) | Capsule どうしをつなぎ、相手の Output を参照できるようにする関係です。Workspace をまたぐ場合は OutputShare を通します。 | [状態と出力](../concepts/state-and-outputs.md) |
| Capsule 作成設定 (InstallConfig) | 変数の対応づけや公開する Output など、Capsule の実行のしかたを Takosumi 側に持つ設定です。 | [API](./api.md) |
| App Handoff | 外部のアプリから利用者を作成画面へ送るための URL の決まりです。 | [App Handoff](./app-handoff.md) |
| Store | 追加できるサービスを探して並べるための一覧です。 | [App Handoff](./app-handoff.md) |

## 実行と記録

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| Run | 1 回の実行の記録です。plan と apply はそれぞれ別の Run になり、apply の Run は確認した plan の Run に固定されます。 | [実行モデル](../concepts/run-model.md) |
| plan | 何がどう変わるかを計算して見せる操作です。この時点では実物は変わりません。 | [実行モデル](../concepts/run-model.md) |
| apply | 確認した plan をそのまま反映する操作です。 | [実行モデル](../concepts/run-model.md) |
| destroy | Capsule が作ったリソースを削除する操作です。計画を作ってから反映します。 | [実行モデル](../concepts/run-model.md) |
| refresh | 外部の実物を変えずに、Takosumi 側の状態と Output を取り込み直す操作です。 | [状態と出力](../concepts/state-and-outputs.md) |
| 差分確認 (drift check) | 保存した状態と実物のずれを、読み取り専用で調べる操作です。 | [状態と出力](../concepts/state-and-outputs.md) |
| drift | 保存した状態と実物のあいだに生まれたずれのことです。 | [状態と出力](../concepts/state-and-outputs.md) |
| RunGroup | 依存関係の順に複数の Run をまとめた記録です。Workspace 全体の更新や差分確認、Capsule の追加・更新・削除で作られます。 | [実行モデル](../concepts/run-model.md) |
| Runner | OpenTofu を実際に動かす隔離された実行環境です。認証情報が渡るのはこの中だけです。 | [実行モデル](../concepts/run-model.md) |
| StateVersion | 適用を終えた時点の状態です。上書きされず、積み重なります。 | [状態と出力](../concepts/state-and-outputs.md) |
| Output | Capsule が外に公開する、秘密でない値です。 | [状態と出力](../concepts/state-and-outputs.md) |
| OutputShare | Workspace をまたいで Output を渡す記録です。受け取る側が承認して有効になります。 | [状態と出力](../concepts/state-and-outputs.md) |
| AuditEvent | 誰が、何に対して、何をして、結果どうなったかを 1 件ずつ残した記録です。 | [実行モデル](../concepts/run-model.md) |
| 台帳 (ledger) | Run や Resource の記録を積み上げていく保存先です。入口が違っても記録先は同じです。 | [実行モデル](../concepts/run-model.md) |

## 認証情報

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| Connection | 認証情報を書き込み専用で保存したものです。作成後に読み出す経路はありません。 | [認証情報](../concepts/credentials.md) |
| ProviderConnection | Connection のうち、OpenTofu の provider に渡すものを指す呼び方です。 | [認証情報](../concepts/credentials.md) |
| ProviderBinding | この Capsule のこの provider にはこの接続を使う、という対応付けです。 | [認証情報](../concepts/credentials.md) |
| CredentialRecipe | provider ごとに必要な環境変数名やファイル名をまとめた設定補助です。 | [認証情報](../concepts/credentials.md) |
| Secret | 暗号化して保存される秘密の値です。 | [認証情報](../concepts/credentials.md) |
| secret partition | 秘密を保存するときの暗号の区画を指す token です。Connection を作るときに指定します。 | [CLI](./cli.md) |
| personal access token | Accounts が発行する API 用のトークンです。`read` / `write` / `admin` の scope を持ちます。 | [CLI](./cli.md) |

## 実行時の連携

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| Interface | デプロイしたものが何を提供しているかの宣言です。 | [Interface](../concepts/interfaces.md) |
| InterfaceBinding | その Interface を誰がどの権限で使えるかの認可です。 | [Interface](../concepts/interfaces.md) |
| Principal | Interface を使う側のうち、人やアカウントにあたる主体です。 | [Interface](../concepts/interfaces.md) |
| ServiceAccount | Interface を使う側のうち、人ではない主体です。 | [Interface](../concepts/interfaces.md) |
| permission | Binding が許す操作を表す token です。トークンを取るときにこの範囲を要求します。 | [Interface](../concepts/interfaces.md) |
| Interface トークン | Interface を呼ぶために要求のたびに発行される、有効期間の短いトークンです。接頭辞は `taksrv_` です。 | [Interface](../concepts/interfaces.md) |

## 型付きサービス

型を宣言するだけでサービスを作る経路で出てくる言葉です。

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| Resource | module を書かずに、宣言だけで作れる型付きのサービスです。 | [Resource](../concepts/resources.md) |
| Resource Shape | Resource の型を指す、現在の API・provider・state での呼び名です。単に shape とも書きます。 | [Resource](../concepts/resources.md) |
| Service Form | 実装から切り離してサービスの型を定義したものです。Resource Shape はその現在の呼び名です。 | [Service Form host API](./takoform-host.md) |
| FormRef | Service Form の定義 1 つを一意に指す識別子です。型名、版、定義の digest から成ります。 | [Service Form host API](./takoform-host.md) |
| Form Package | 定義の schema と付随情報だけを収めた bundle です。 | [API](./api.md) |
| Form Registry | endpoint が信頼して固定した Form Package の一覧です。 | [API](./api.md) |
| FormActivation | どの Form を誰に公開するかを operator が決める記録です。 | [API](./api.md) |
| Space | Resource API の名前空間です。platform 経由の要求では Workspace の id と一致させます。 | [API](./api.md) |
| Target | Resource を実際に作る先です。 | [Resource](../concepts/resources.md) |
| TargetPool | operator が有効にした Target の候補をまとめたものです。 | [Resource](../concepts/resources.md) |
| SpacePolicy | どの Resource をどこへ解決してよいかのルールです。 | [API](./api.md) |
| Resolver | 宣言された Resource から、使う実装と配置先を選ぶ仕組みです。 | [Resource](../concepts/resources.md) |
| Adapter | 選ばれた実装を実際のリソースにする部品です。preview、apply、import、observe、refresh、delete を受け持ちます。 | [Resource](../concepts/resources.md) |
| ResolutionLock | 一度決まった実装と配置先を固定する記録です。 | [Resource](../concepts/resources.md) |
| NativeResource | Adapter が実際に作った、provider 側のリソースの記録です。 | [Resource](../concepts/resources.md) |
| observe | Resource に対する読み取り専用の差分確認です。 | [Resource](../concepts/resources.md) |
| import | すでにある実物を Takosumi の記録に取り込む操作です。 | [Resource](../concepts/resources.md) |
| portability | 選んだ解決の移しやすさの区分です。`portable` / `mostly_portable` / `partial` / `locked_in` があります。 | [Resource](../concepts/resources.md) |
| Compatibility API | S3 や OCI のような標準プロトコルを、範囲と版を決めて受け付ける入口です。 | [API](./api.md) |

## 状態の読み方

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| phase | 観測された段階です。Resource なら `Pending` から `Ready` や `Failed` までを取ります。 | [API](./api.md) |
| Ready | 使える状態を表す語です。Resource と InterfaceBinding では phase の値、Condition では type の 1 つです。 | [API](./api.md) |
| Condition | 状態の根拠を 1 件ずつ残す記録です。type と `true` / `false` / `unknown` と理由が入ります。 | [API](./api.md) |
| generation | 望む状態の版番号です。宣言を変えるたびに進みます。 | [API](./api.md) |
| observedGeneration | status がどの generation を見て書かれたかを示す番号です。 | [API](./api.md) |

## 横断して出てくる言葉

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| capability | その endpoint で何が有効かを表す token です。edition の名前ではなくこれを見ます。 | [製品の境界](../concepts/boundaries.md) |
| profile | 範囲を決めて名前を付けた設定の束です。互換 API の `compat.s3.v1` や、EdgeWorker が実行環境に求める `profiles` があります。 | [API](./api.md) |
| surface | 外から使える入口のまとまりです。`/api/v1` と `/v1` は別の surface です。 | [API](./api.md) |
| digest | 内容から計算した SHA-256 の指紋です。同じ内容なら必ず同じ値になります。 | [API](./api.md) |
| fail closed | 判断がつかないときに、通さずに止める動き方です。 | [Interface](../concepts/interfaces.md) |
| lease | 同じ対象を 2 か所で同時に処理しないよう、担当を期限つきで確保する仕組みです。 | [Resource](../concepts/resources.md) |
| CAS (compare-and-swap) | 更新の直前に、読んだときの版のままかを確かめ、変わっていたら書き込まない方式です。 | [API](./api.md) |
| cursor | 一覧の続きを読むための不透明な token です。中身は解釈せず、次の要求にそのまま渡します。 | [API](./api.md) |

その endpoint でどの capability が有効かは、endpoint 自身が答えます。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
```

## 運用する主体

| 用語 | 意味 | 詳しい説明 |
| --- | --- | --- |
| Operator | Takosumi を自分や自分のユーザーのために運用する主体です。 | [製品の境界](../concepts/boundaries.md) |
| Takosumi Cloud | 公式に運用している hosted サービスです。 | [製品の境界](../concepts/boundaries.md) |
| showback | 使った量を記録して見せるところまでを行う課金モードです。 | [利用量と課金](../concepts/usage-and-billing.md) |
| ServiceOffering | Cloud が提供するサービスを、価格や容量まで含めて定義した記録です。 | [製品の境界](../concepts/boundaries.md) |
