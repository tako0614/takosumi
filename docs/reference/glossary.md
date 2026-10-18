# 用語集

Takosumi のドキュメントに出てくる言葉を、1 語ずつ短く説明します。動きの説明は右端の
ページにあります。この docs では「正本」を「正とする情報 (そのデータについて最終的に
信頼できる管理元)」の意味で使います。

## 画面の言葉と内部の言葉

dashboard は内部の用語をそのまま出さず、次の言葉を使います。API やこのドキュメントで
別の名前を見かけたときは、この対応で読み替えてください。

| 画面の言葉         | 内部の用語                           | 指しているもの                                       |
| ------------------ | ------------------------------------ | ---------------------------------------------------- |
| サービス           | Store の掲載項目（listing。追加後は Capsule） | ストアで選んで追加するもので、追加後も同じ名前です。 |
| ワークロード       | Capsule の一覧                       | 追加したサービスが並ぶ画面です。                     |
| アプリ             | ホームに出す宣言（launcher）をした、画面を持つ Interface | サービス自身の画面で、ホームから開けます（[ホームにアプリを出す](../getting-started/home-launcher.md)）。 |
| 接続済みアカウント | ProviderConnection / ProviderBinding | 保存した認証情報と、その割り当てです。               |
| 変更内容           | plan                                 | デプロイする前に確認する変更の一覧です。             |
| 変更内容の検証 ID  | planDigest                           | 確認した計画とデプロイする計画が同じだと確かめる値です。 |
| デプロイ履歴       | Run の一覧                           | 変更の確認・承認・デプロイを、新しい順に並べます。   |
| 更新履歴           | StateVersion の一覧                  | サービスの 更新 タブで、デプロイした版が並びます。   |
| リソース           | 適用した plan に記録された OpenTofu の resource | サービスが作った resource の記録です。更新タブの「デプロイ済みリソース」に、現在の版の一覧が出ます。ライブの稼働状態ではありません。 |
| ホスト済みリソース | ホスト環境が提供する読み取り専用の一覧 | ワークスペースで管理されているリソースを確かめる画面です。ホスト環境が対応している場合だけ使えます。 |
| 操作履歴           | Activity / AuditEvent                | 誰がいつ何をしたかが並びます。                       |
| この状態に戻す     | StateVersion からの復元              | 過去の状態を選び直す操作です。                       |

## 全体の骨組み

| 用語                             | 意味                                                                                                                    | 詳しい説明                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Takosumi                         | Git に置いた OpenTofu / Terraform の module を、変更の確認・承認・デプロイの順に実行して履歴を残す control plane です。           | [Takosumi とは](../index.md)                   |
| OpenTofu                         | インフラをコードで定義して適用するオープンソースのツールです。Terraform と互換があります。                              | [Takosumi とは](../index.md)                   |
| Workspace                        | Personal、Work、Experiments、Client など目的ごとの個人の用途・リソース・セキュリティ境界です。メンバーシップと共有は必要なときに追加し、メンバー、権限、接続、履歴もこの境界で分かれます。 | [全体像](../concepts/index.md)                 |
| Handle                           | Workspace の安定したグローバル一意の公開 API 識別子です。`@handle` と書きます。API / CLI から指定できますが、必須の利用者選択ではありません。標準ダッシュボードは作成時に自動生成し、Workspace の設定画面などで表示します。 | [全体像](../concepts/index.md)                 |
| Project                          | Workspace の中を整理するための区分です。                                                                                                                                                | [全体像](../concepts/index.md)                 |
| Source                           | どのリポジトリの、どのディレクトリを、どの ref で追うかという登録です。                                                                                                                 | [Source と Capsule](../concepts/sources.md)    |
| SourceSnapshot                   | Source が ref を解決した結果の commit です。実行されるのはいつもこちらです。                                                                                                            | [Source と Capsule](../concepts/sources.md)    |
| Capsule                          | デプロイされたひとまとまりです。OpenTofu の root module 1 つ分が動き、`production` や `preview` のような具体的な実行環境も Capsule が持ちます。                                              | [Source と Capsule](../concepts/sources.md)    |
| Environment                      | Capsule が持つ具体的な実行環境です（`production`、`preview` など）。Workspace の別名ではありません。                                                                                      | [Source と Capsule](../concepts/sources.md)    |
| stale                            | デプロイ済みの Capsule の、追いかけている Source に新しい commit が来たか、依存先の Output が変わった状態です。画面では **更新があります** と表示されます。 | [Source と Capsule](../concepts/sources.md)    |
| Stack flow                       | 自分で書いた module を Git から実行する経路です。                                                                       | [全体像](../concepts/index.md)                 |
| 互換性レポート                   | 登録した module を読み取り専用で解析し、必要な変数と provider を示した結果です。                                        | [Source と Capsule](../concepts/sources.md)    |
| 依存 (Dependency)                | Capsule どうしをつなぎ、相手の Output を参照できるようにする関係です。Workspace をまたぐ場合は OutputShare を通します。 | [状態と出力](../concepts/state-and-outputs.md) |
| Capsule 作成設定 (InstallConfig) | 変数の対応づけや公開する Output など、Capsule の実行のしかたを Takosumi 側に持つ設定です。                              | [API](./api.md)                                |
| Git revision plan                | 既存の Capsule の取得元の版を変えるとき、commit を固定し、互換性を確かめて、変更の確認（Plan Run）を作るまでの手続きの記録です。dashboard の **更新する**（更新があるときに表示）、**変更を確認**、**バージョンを変更** の **このバージョンを確認** で作られます。 | [API](./api.md)                                |
| 採用済み Source revision         | Capsule の現在の StateVersion が参照する Plan Run から導出した SourceSnapshot の ref/path/commit です。Source の既定 ref とは別です。 | [API](./api.md)                                |
| App Handoff                      | 外部のアプリから利用者を作成画面へ送るための URL の決まりです。                                                         | [App Handoff](./app-handoff.md)                |
| Store                            | 追加できるサービスを探して並べるための一覧です。                                                                        | [App Handoff](./app-handoff.md)                |

## 実行と記録

| 用語                   | 意味                                                                                                                  | 詳しい説明                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Run                    | 1 回の実行の記録です。plan と apply はそれぞれ別の Run になり、apply の Run は確認した plan の Run に固定されます。   | [実行モデル](../concepts/run-model.md)         |
| plan                   | 何がどう変わるかを計算して見せる操作です。この時点では実物は変わりません。                                            | [実行モデル](../concepts/run-model.md)         |
| apply                  | 確認した plan をそのままデプロイする操作です。画面では **デプロイ** と表示されます。                                      | [実行モデル](../concepts/run-model.md)         |
| destroy                | Capsule が作ったリソースを削除する操作です。計画を作ってから実行します。                                              | [実行モデル](../concepts/run-model.md)         |
| 差分確認 (drift check) | 保存した状態と実物のずれを、読み取り専用で調べる操作です。                                                            | [状態と出力](../concepts/state-and-outputs.md) |
| drift                  | 保存した状態と実物のあいだに生まれたずれのことです。                                                                  | [状態と出力](../concepts/state-and-outputs.md) |
| RunGroup               | 依存関係の順に複数の Run をまとめた記録です。Workspace 全体の更新や差分確認で作られます。 | [実行モデル](../concepts/run-model.md)         |
| Runner                 | OpenTofu を実際に動かす隔離された実行環境です。認証情報が渡るのはこの中だけです。                                     | [実行モデル](../concepts/run-model.md)         |
| StateVersion           | デプロイ（apply）の結果として記録された状態です。失敗した apply でも記録されることがあります。上書きされず、積み重なります。                                                            | [状態と出力](../concepts/state-and-outputs.md) |
| Output                 | Capsule が外に公開する、秘密でない値です。                                                                            | [状態と出力](../concepts/state-and-outputs.md) |
| OutputShare            | Workspace をまたいで Output を渡す記録です。受け取る側が承認して有効になります。                                      | [状態と出力](../concepts/state-and-outputs.md) |
| AuditEvent             | 誰が、何に対して、何をして、結果どうなったかを 1 件ずつ残した記録です。                                               | [実行モデル](../concepts/run-model.md)         |
| ledger                 | Run、StateVersion、Output、監査の記録を積み上げていく保存先です。入口が違っても記録先は同じです。         | [実行モデル](../concepts/run-model.md)         |

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

## 状態の読み方

| 用語               | 意味                                                                                                    | 詳しい説明      |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --------------- |
| phase              | 観測された段階です。InterfaceBinding なら `Pending`、`Ready`、`NotReady`、`Revoked` のどれかを取ります。 | [API](./api.md) |
| Ready              | 使える状態を表す語です。InterfaceBinding では phase の値、Condition では type の 1 つです。             | [API](./api.md) |
| Condition          | 状態の根拠を 1 件ずつ残す記録です。type と `true` / `false` / `unknown` と理由が入ります。              | [API](./api.md) |
| generation         | 望む状態の版番号です。宣言を変えるたびに進みます。                                                      | [API](./api.md) |
| observedGeneration | status がどの generation を見て書かれたかを示す番号です。                                               | [API](./api.md) |

## 横断して出てくる言葉

| 用語                   | 意味                                                                                                                       | 詳しい説明                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| capability             | その endpoint で何が有効かを表す token です。edition の名前ではなくこれを見ます。                                          | [製品の境界](../concepts/boundaries.md) |
| profile                | 範囲を決めて名前を付けた設定の束です。runner の実行条件を決める RunnerProfile などがあります。 | [認証情報](../concepts/credentials.md)                         |
| surface                | 外から使える入口のまとまりです。Takosumi の公開 JSON API は `/api/v1`、operator API は `/internal/v1` です。旧 `/v1` は公開 surface ではありません。 | [API](./api.md)                         |
| digest                 | 内容から計算した SHA-256 の指紋です。同じ内容なら必ず同じ値になります。                                                    | [API](./api.md)                         |
| fail closed            | 判断がつかないときに、通さずに止める動き方です。                                                                           | [Interface](../concepts/interfaces.md)  |
| lease                  | 同じ対象を 2 か所で同時に処理しないよう、担当を期限つきで確保する仕組みです。                                              | [API](./api.md)                         |
| materialization      | 宣言した Interface / Binding / credential を、実行する host や runner の上にだけ実体として用意することです。宣言や plan には秘密の値を書きません。 | [Interface](../concepts/interfaces.md)  |
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
| Takosumi hosted service | 公式に運用している hosted サービスです。          | [製品の境界](../concepts/boundaries.md)          |
| showback       | 使った量を記録して見せるところまでを行う課金モードです。  | [利用量と課金](../concepts/usage-and-billing.md) |

## 旧 Resource / Form の移行用語

次の語は、廃止した Resource Shape / Form Host の API、保存データ、移行の runbook に残る内部の
語と、Takoform などの外部 Host の語です。Takosumi のいまの使い方には出てきません。dashboard の
**リソース**（サービスが作った resource の記録）とは別のものです。現在は、Git の module と
通常の OpenTofu provider を使います。

::: details 移行用語の一覧を開く

| 用語              | 意味                                                                                                          | 詳しい説明                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Resource          | 旧 API が保持する型付きサービスの記録 (migration only)。                                                     | [Resource migration](../concepts/resources.md) |
| Resource Shape    | 旧 API・schema・state で Resource の型を表す名前 (migration only)。                                            | [Resource migration](../concepts/resources.md) |
| Service Form      | Takoform 側の portable 概念。Takosumi OSS の Host ownership ではありません。                                          | [Resource migration](../concepts/resources.md) |
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
| import            | 旧 Resource ledger へ既存実物を取り込む操作 (migration only)。                                                   | [Resource migration](../concepts/resources.md) |
| portability       | 旧 Resource 解決の移しやすさ (migration only)。                                                             | [Resource migration](../concepts/resources.md) |

:::
