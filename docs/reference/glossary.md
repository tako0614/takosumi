# 用語集

Takosumi のドキュメントに出てくる言葉を、1 語ずつ短く説明します。動きの説明は右端の
ページにあります。

## 画面の言葉と内部の言葉

dashboard は内部の用語をそのまま出さず、次の言葉を使います。API やこのドキュメントで
別の名前を見かけたときは、この対応で読み替えてください。

| 画面の言葉         | 内部の用語                           | 指しているもの                                       |
| ------------------ | ------------------------------------ | ---------------------------------------------------- |
| サービス / アプリ  | Capsule                              | デプロイされたひとまとまりです。                     |
| 接続済みアカウント | ProviderConnection / ProviderBinding | 保存した認証情報と、その割り当てです。               |
| 変更内容           | plan                                 | 反映する前に確認する変更の一覧です。                 |
| 変更内容の検証 ID  | planDigest                           | 確認した計画と適用する計画が同じだと確かめる値です。 |
| 更新履歴           | Run の一覧                           | いつ何を流したかが並びます。                         |
| 操作履歴           | Activity / AuditEvent                | 誰がいつ何をしたかが並びます。                       |
| この状態に戻す     | StateVersion からの復元              | 過去の状態を選び直す操作です。                       |

## 全体の骨組み

| 用語                             | 意味                                                                                                                    | 詳しい説明                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Takosumi                         | Git に置いた OpenTofu / Terraform の module を、計画・確認・反映の順に実行して履歴を残す control plane です。           | [Takosumi とは](../index.md)                   |
| OpenTofu                         | インフラをコードで定義して適用するオープンソースのツールです。Terraform と互換があります。                              | [Takosumi とは](../index.md)                   |
| Workspace                        | Personal、Work、Experiments、Client など目的ごとの個人の用途・リソース・セキュリティ境界です。メンバーシップと共有は必要なときに追加し、メンバー、権限、接続、履歴もこの境界で分かれます。 | [全体像](../concepts/index.md)                 |
| Handle                           | Workspace の安定したグローバル一意の公開 API 識別子です。`@handle` と書きます。API / CLI から指定できますが、必須の利用者選択ではありません。標準ダッシュボードは通常自動生成し、名前の重複時や詳細設定でだけ表示します。 | [全体像](../concepts/index.md)                 |
| Project                          | Workspace の中を整理するための区分です。                                                                                                                                                | [全体像](../concepts/index.md)                 |
| Source                           | どのリポジトリの、どのディレクトリを、どの ref で追うかという登録です。                                                                                                                 | [Source と Capsule](../concepts/sources.md)    |
| SourceSnapshot                   | Source が ref を解決した結果の commit です。実行されるのはいつもこちらです。                                                                                                            | [Source と Capsule](../concepts/sources.md)    |
| Capsule                          | デプロイされたひとまとまりです。OpenTofu の root module 1 つ分が動き、`production` や `preview` のような具体的な実行環境も Capsule が持ちます。                                              | [Source と Capsule](../concepts/sources.md)    |
| Environment                      | Capsule が持つ具体的な実行環境です（`production`、`preview` など）。Workspace の別名ではありません。                                                                                      | [Source と Capsule](../concepts/sources.md)    |
| stale                            | 追いかけている Source に新しい commit が来た Capsule の状態です。                                                       | [Source と Capsule](../concepts/sources.md)    |
| Stack flow                       | 自分で書いた module を Git から実行する経路です。                                                                       | [全体像](../concepts/index.md)                 |
| 互換性レポート                   | 登録した module を読み取り専用で解析し、必要な変数と provider を示した結果です。                                        | [Source と Capsule](../concepts/sources.md)    |
| 依存 (Dependency)                | Capsule どうしをつなぎ、相手の Output を参照できるようにする関係です。Workspace をまたぐ場合は OutputShare を通します。 | [状態と出力](../concepts/state-and-outputs.md) |
| Capsule 作成設定 (InstallConfig) | 変数の対応づけや公開する Output など、Capsule の実行のしかたを Takosumi 側に持つ設定です。                              | [API](./api.md)                                |
| App Handoff                      | 外部のアプリから利用者を作成画面へ送るための URL の決まりです。                                                         | [App Handoff](./app-handoff.md)                |
| Store                            | 追加できるサービスを探して並べるための一覧です。                                                                        | [App Handoff](./app-handoff.md)                |

## 実行と記録

| 用語                   | 意味                                                                                                                  | 詳しい説明                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Run                    | 1 回の実行の記録です。plan と apply はそれぞれ別の Run になり、apply の Run は確認した plan の Run に固定されます。   | [実行モデル](../concepts/run-model.md)         |
| plan                   | 何がどう変わるかを計算して見せる操作です。この時点では実物は変わりません。                                            | [実行モデル](../concepts/run-model.md)         |
| apply                  | 確認した plan をそのまま反映する操作です。                                                                            | [実行モデル](../concepts/run-model.md)         |
| destroy                | Capsule が作ったリソースを削除する操作です。計画を作ってから反映します。                                              | [実行モデル](../concepts/run-model.md)         |
| refresh                | 外部の実物を変えずに、Takosumi 側の状態と Output を取り込み直す操作です。                                             | [状態と出力](../concepts/state-and-outputs.md) |
| 差分確認 (drift check) | 保存した状態と実物のずれを、読み取り専用で調べる操作です。                                                            | [状態と出力](../concepts/state-and-outputs.md) |
| drift                  | 保存した状態と実物のあいだに生まれたずれのことです。                                                                  | [状態と出力](../concepts/state-and-outputs.md) |
| RunGroup               | 依存関係の順に複数の Run をまとめた記録です。Workspace 全体の更新や差分確認、Capsule の追加・更新・削除で作られます。 | [実行モデル](../concepts/run-model.md)         |
| Runner                 | OpenTofu を実際に動かす隔離された実行環境です。認証情報が渡るのはこの中だけです。                                     | [実行モデル](../concepts/run-model.md)         |
| StateVersion           | 適用を終えた時点の状態です。上書きされず、積み重なります。                                                            | [状態と出力](../concepts/state-and-outputs.md) |
| Output                 | Capsule が外に公開する、秘密でない値です。                                                                            | [状態と出力](../concepts/state-and-outputs.md) |
| OutputShare            | Workspace をまたいで Output を渡す記録です。受け取る側が承認して有効になります。                                      | [状態と出力](../concepts/state-and-outputs.md) |
| AuditEvent             | 誰が、何に対して、何をして、結果どうなったかを 1 件ずつ残した記録です。                                               | [実行モデル](../concepts/run-model.md)         |
| 台帳 (ledger)          | Run や Resource の記録を積み上げていく保存先です。入口が違っても記録先は同じです。                                    | [実行モデル](../concepts/run-model.md)         |

## 認証情報

| 用語                  | 意味                                                                                       | 詳しい説明                             |
| --------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| Connection            | 認証情報を書き込み専用で保存したものです。作成後に読み出す経路はありません。               | [認証情報](../concepts/credentials.md) |
| ProviderConnection    | Connection のうち、OpenTofu の provider に渡すものを指す呼び方です。                       | [認証情報](../concepts/credentials.md) |
| ProviderBinding       | この Capsule のこの provider にはこの接続を使う、という対応付けです。                      | [認証情報](../concepts/credentials.md) |
| CredentialRecipe      | provider ごとに必要な環境変数名やファイル名をまとめた設定補助です。                        | [認証情報](../concepts/credentials.md) |
| Secret                | 暗号化して保存される秘密の値です。                                                         | [認証情報](../concepts/credentials.md) |
| secret partition      | 秘密を保存するときの暗号の区画を指す token です。Connection を作るときに指定します。       | [CLI](./cli.md)                        |
| personal access token | Accounts が発行する API 用のトークンです。core scope と、owning route が明示した Workspace-bound extension scope を持てます。`admin` は operator 発行専用です。 | [API](./api.md)                        |

## 実行時の連携

| 用語               | 意味                                                                                                      | 詳しい説明                             |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Interface          | デプロイしたものが何を提供しているかの宣言です。                                                          | [Interface](../concepts/interfaces.md) |
| InterfaceBinding   | その Interface を誰がどの権限で使えるかの認可です。                                                       | [Interface](../concepts/interfaces.md) |
| Principal          | Interface を使う側のうち、人やアカウントにあたる主体です。                                                | [Interface](../concepts/interfaces.md) |
| ServiceAccount     | Interface を使う側のうち、人ではない主体です。                                                            | [Interface](../concepts/interfaces.md) |
| permission         | Binding が許す操作を表す token です。トークンを取るときにこの範囲を要求します。                           | [Interface](../concepts/interfaces.md) |
| Interface トークン | Interface を呼ぶための、最大 60 秒だけ有効な更新不可の token です。文字列形式は発行する host が決めます。 | [Interface](../concepts/interfaces.md) |

## 旧 Resource / Form migration vocabulary

次の語は旧 Resource Shape / Form Host API、保存データ、migration runbook にだけ残る
内部語彙です。Takosumi OSS の supported authoring surface や dashboard navigation を
示しません。現行の利用者向け経路では、Git module と通常の OpenTofu provider を使います。

| 用語              | 意味                                                                                                          | 詳しい説明                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Resource          | 旧 API が保持する型付きサービスの記録 (migration only)。                                                     | [Resource migration](../concepts/resources.md) |
| Resource Shape    | 旧 API・schema・state で Resource の型を表す名前 (migration only)。                                            | [Resource migration](../concepts/resources.md) |
| Service Form      | Takoform 側の portable 概念。Takosumi OSS の Host ownership ではない。                                          | [Resource migration](../concepts/resources.md) |
| FormRef           | Takoform の exact な Form 定義を指す識別子 (external Host vocabulary)。                                        | [Resource migration](../concepts/resources.md) |
| Form Package      | Takoform の定義 schema と付随情報の bundle (external Host vocabulary)。                                       | [Resource migration](../concepts/resources.md) |
| Form Registry     | external Host が信頼して固定する Form Package の一覧 (migration only)。                                      | [Resource migration](../concepts/resources.md) |
| FormActivation    | external Host/operator の Form 公開記録 (migration only)。                                                    | [Resource migration](../concepts/resources.md) |
| Space             | 旧 Resource API の namespace (migration only)。                                                              | [Resource migration](../concepts/resources.md) |
| Target            | 旧 Resource を作る先の記録 (migration only)。                                                                | [Resource migration](../concepts/resources.md) |
| TargetPool        | 旧 operator target 候補の記録 (migration only)。                                                             | [Resource migration](../concepts/resources.md) |
| SpacePolicy       | 旧 Resource の配置制約 (migration only)。                                                                    | [Resource migration](../concepts/resources.md) |
| Resolver          | 旧 Resource の実装・配置選択部品 (migration only)。                                                         | [Resource migration](../concepts/resources.md) |
| Adapter           | 旧 Resource backend adapter (migration only)。                                                              | [Resource migration](../concepts/resources.md) |
| ResolutionLock    | 旧 Resource の実装・配置固定記録 (migration only)。                                                         | [Resource migration](../concepts/resources.md) |
| NativeResource    | 旧 adapter が作った provider 側 resource の記録 (migration only)。                                           | [Resource migration](../concepts/resources.md) |
| observe           | 旧 Resource の読み取り専用差分確認 (migration only)。                                                        | [Resource migration](../concepts/resources.md) |
| import            | 旧 Resource 台帳へ既存実物を取り込む操作 (migration only)。                                                   | [Resource migration](../concepts/resources.md) |
| portability       | 旧 Resource 解決の移しやすさ (migration only)。                                                             | [Resource migration](../concepts/resources.md) |
| Compatibility API | S3 や OCI のような標準プロトコルを、範囲と版を決めて受け付ける入口です。                                      | [API](./api.md)                             |

## 状態の読み方

| 用語               | 意味                                                                                                    | 詳しい説明      |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --------------- |
| phase              | 観測された段階です。Resource なら `Pending` から `Ready` や `Failed` までを取ります。                   | [API](./api.md) |
| Ready              | 使える状態を表す語です。Resource と InterfaceBinding では phase の値、Condition では type の 1 つです。 | [API](./api.md) |
| Condition          | 状態の根拠を 1 件ずつ残す記録です。type と `true` / `false` / `unknown` と理由が入ります。              | [API](./api.md) |
| generation         | 望む状態の版番号です。宣言を変えるたびに進みます。                                                      | [API](./api.md) |
| observedGeneration | status がどの generation を見て書かれたかを示す番号です。                                               | [API](./api.md) |

## 横断して出てくる言葉

| 用語                   | 意味                                                                                                                       | 詳しい説明                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| capability             | その endpoint で何が有効かを表す token です。edition の名前ではなくこれを見ます。                                          | [製品の境界](../concepts/boundaries.md) |
| profile                | 範囲を決めて名前を付けた設定の束です。互換 API の `compat.s3.v1` や、EdgeWorker が実行環境に求める `profiles` があります。 | [API](./api.md)                         |
| surface                | 外から使える入口のまとまりです。`/api/v1` と `/v1` は別の surface です。                                                   | [API](./api.md)                         |
| digest                 | 内容から計算した SHA-256 の指紋です。同じ内容なら必ず同じ値になります。                                                    | [API](./api.md)                         |
| fail closed            | 判断がつかないときに、通さずに止める動き方です。                                                                           | [Interface](../concepts/interfaces.md)  |
| lease                  | 同じ対象を 2 か所で同時に処理しないよう、担当を期限つきで確保する仕組みです。                                              | [API](./api.md)                         |
| CAS (compare-and-swap) | 更新の直前に、読んだときの版のままかを確かめ、変わっていたら書き込まない方式です。                                         | [API](./api.md)                         |
| cursor                 | 一覧の続きを読むための不透明な token です。中身は解釈せず、次の要求にそのまま渡します。                                    | [API](./api.md)                         |

その endpoint でどの capability が有効かは、endpoint 自身が答えます。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
```

## 運用する主体

| 用語           | 意味                                                      | 詳しい説明                                       |
| -------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Operator       | Takosumi を自分や自分のユーザーのために運用する主体です。 | [製品の境界](../concepts/boundaries.md)          |
| Takosumi Cloud | 公式に運用している hosted サービスです。                  | [製品の境界](../concepts/boundaries.md)          |
| showback       | 使った量を記録して見せるところまでを行う課金モードです。  | [利用量と課金](../concepts/usage-and-billing.md) |
