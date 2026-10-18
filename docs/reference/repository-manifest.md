# Repository manifest

`.well-known/takosumi.json` は、リポジトリの最上位に置く任意のファイルです。Takosumi が見つけた
OpenTofu の module ごとに、追加画面の入力欄の説明、Takosumi に用意してほしい機能（秘密の生成、
公開 URL、サインイン、Interface など）、その値を module のどの変数に渡すかを書きます。置かなくても、
Git の OpenTofu module はそのまま追加できます。書き方の例は
[追加できるリポジトリを用意する](../getting-started/prepare-repository.md)と
[ホームにアプリを出す](../getting-started/home-launcher.md)にあります。このページは項目と規則の
一覧です。

manifest に書けるのは提案だけです。機能の実装は Takosumi が持ち、manifest にできるのは、その機能を
求めることと、受け取った値を OpenTofu の変数へ渡す対応づけだけです。manifest は実行するコードと同じ
commit に固定されます。provider、接続、作るもの、デプロイと削除は、アプリ側の Git にある OpenTofu の
設定で決まり、manifest では変えられません。module と provider の候補を決めるのは、Git URL、ref、
`sourcePath`、固定した commit で追跡されているファイルを Takosumi が調べた結果です。利用者は、その
候補から追加する module を選びます。

manifest は次のように扱われます。

- Source を同期するとき、同じ commit の manifest を読み、128 KiB までの UTF-8 JSON として確かめます。
  結果と digest は、後から変わらない `SourceSnapshot.repositoryManifest` に保存します。文書そのものは
  公開 API では返しません。
- 追加するとき、固定したその SourceSnapshot の宣言を、同じ snapshot の互換性の確認結果と突き合わせ、
  運用している人の policy の範囲で、データベースに保存する追加時の設定（`InstallConfig`）に変換します。変更の確認と
  デプロイ（Plan / Run）が読むのはこの保存した設定で、manifest を読み直しません。

## 版と書ける項目

どの版でも、最上位に書けるのは次の 3 つだけです。

```json
{
  "apiVersion": "takosumi.com/v2.3",
  "kind": "Repository",
  "install": {}
}
```

| `apiVersion`        | `install` に書ける項目 | module に書ける項目                         |
| ------------------- | ---------------------- | ------------------------------------------- |
| `takosumi.com/v1`   | `modules`              | `inputs`, `requires`, `features`            |
| `takosumi.com/v2`   | `modules`              | v1 + `interfaces`                           |
| `takosumi.com/v2.1` | `modules`、`defaultModule`（任意） | v2 と同じ                                   |
| `takosumi.com/v2.2` | `modules`、`defaultModule`（任意） | v2.1 + `requires[].kind: interface.consume` |
| `takosumi.com/v2.3` | `modules`、`defaultModule`（任意） | v2.2 + `sourceBuild`（任意）               |
| `takosumi.com/v2.4` | `modules`              | v2.3 + OIDC の値を実行時の binding で渡す        |

どの階層の object も、書ける項目が決まっています。表や各節にない項目、`$schema`、古い
`schemaVersion: takosumi.install-ux/v1` を書くと拒否されます。

公開 JSON Schema は
[`repository-manifest-v2.1.schema.json`](/schemas/repository-manifest-v2.1.schema.json) と
[`repository-manifest-v2.2.schema.json`](/schemas/repository-manifest-v2.2.schema.json) と
[`repository-manifest-v2.3.schema.json`](/schemas/repository-manifest-v2.3.schema.json) と
[`repository-manifest-v2.4.schema.json`](/schemas/repository-manifest-v2.4.schema.json)
です。Schema が確かめるのは形だけで、Takosumi の検査と完全には一致しません。項目どうしの重複、
JSON の入れ子の深さ（最大 32）、秘密や権限を表す語（下の「Authority と secret の境界」）は、Takosumi が
さらに確かめ、合わなければ受け付けません。

## 調べた module と manifest の項目

`install.modules` には 1〜32 件を書きます。key は module のフォルダを、リポジトリの最上位から書いた
ものです（最上位なら `.`、1,024 文字まで）。`/` や `./` で始まるもの、ドライブ名、末尾の `/`、`\`、
NUL、空の区切り、`.` や `..` の区切りは使えません。その項目が入力欄の説明や機能の要求として使われるのは、固定した
commit を調べた結果、同じフォルダに module があるときだけです。manifest で module を作ったり、選んだり、置き換えたり
はできません。

Takosumi が調べた module の一覧は、認証済みの
`GET /api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/install-modules` で読めます。応答には
`status`、`sourceSnapshotId`、`scopePath` と、調べた結果の
`modules: [{ path, providerPackages, rootProviderRequirements }]` が入ります。`providerPackages` は
たどれる provider package のすべて（policy、lock、mirror 用）、`rootProviderRequirements` は選んだ
root module が直接求める provider の local name と alias の組を、そのままの形で示したもの（接続の割り当てと
root module の生成用）です。dashboard はこの一覧から module を選んで互換性を確かめます。Git URL から
追加するときもストアから追加するときも、Git URL と ref に、任意の module のフォルダの目安を添えた同じ
流れで、ストアの情報や保存されているデプロイの設定が module、provider、policy を選ぶことはありません。
この API は、サインイン済みの利用者であること、Source の Workspace へのアクセス、その SourceSnapshot が
その Source のものであることを確かめます。

候補が 1 件なら dashboard が自動で選び、複数なら利用者が選びます。manifest にだけあるフォルダは候補に
なりません。追加リンクの `path` も、固定した commit を調べた結果に無ければ使われず、dashboard は調べた
候補から選び直します。追加の計画（install plan）に指定した module のフォルダが固定した archive に
無いと、その plan は
`repository_install_ux_module_missing` で失敗します。フォルダが `sourcePath` を繰り返している
（リポジトリの最上位から書いた）ときは `repository_install_ux_module_path_repository_relative` で
失敗します。

manifest が無くても、調べた module は使えます。manifest が読めないときや規則に合わないときも、内容を
推し量ったり一部だけ使ったりせず、manifest の情報を使わずに、調べた結果だけで追加を続けます。
運用している人が特定の manifest の版を必須にしている場合だけ、manifest が無い、読めない、版が違う
ときに追加を止めます。

公開済みの v2.1〜v2.3 の `install.defaultModule`（任意）は今も読み、`install.modules` の key と一致
するかを確かめますが、表示の目安にしか使いません。複数の module があるときに利用者が選ぶ手順は省けず、
実行する module を決めることもありません。

Takosumi が調べるのは、manifest の有無や版にかかわらず、固定した archive の中の追跡されている通常の
ファイルと、リポジトリの中の local module（`./`、`../`）だけです。registry や `git::` などのリモートの
module source は、版を固定していても取得しません。見つかると、候補の一部だけを出すことはせず、その
scan の結果全体を `invalid` にします。`../` も、選んだ module のディレクトリの外を指すと追加できません。使う module は
リポジトリに入れてください（[追加できるリポジトリを用意する](../getting-started/prepare-repository.md)）。

### 有効な v2.1 multi-module 例

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "modules": {
      ".": { "inputs": [] },
      "deploy/takoform": { "inputs": [] }
    }
  }
}
```

## `inputs`

各 module の `inputs` は必須の配列で、最大 128 件です。各 entry に書ける項目は次のとおりです。

| 項目          | 必須 | 内容                                                         |
| ------------- | ---- | ------------------------------------------------------------ |
| `name`        | yes  | OpenTofu の変数名（正確に一致するもの）                      |
| `source`      | yes  | `{ "kind": ... }` だけ                                       |
| `label`       | yes  | 空でない `{ "ja", "en" }`                                    |
| `role`        | no   | `service_name` か `initial_secret`                           |
| `type`        | no   | `string`、`number`、`boolean`、`json`                        |
| `format`      | no   | 表示の形を表す、長さに上限のある token                       |
| `required`    | no   | boolean                                                      |
| `helper`      | no   | `{ "ja", "en" }`                                             |
| `placeholder` | no   | 空でない、長さに上限のある文字列                             |
| `advanced`    | no   | boolean                                                      |
| `secret`      | no   | 利用者の入力を、秘密として用意して渡す（secret materialization）印 |

`source.kind` は `user`、`capsule_name`、`workspace_scoped_capsule_name`、`module_default` の
どれかです。`secret: true` を付けられるのは `user` だけで、`module_default` には `required: true` を
付けられません。`env` のような環境変数の map を、秘密や `initial_secret` として公開することはできません。
入力の名前と role は module の中で重複できず、名前の前後の空白は取り除かずに、正規の形でなければ
拒否します。互換性の確認結果で、その変数があること、型、既定値の有無を確かめられなければ使われません。
表示用の label、helper、placeholder は、よく知られた認証情報らしい形を検査しますが、「Use a token
value」のようなふつうの文章は通します。

## `requires`

`requires` は任意で、最大 16 件です。値や認証情報ではなく、Takosumi に用意してほしい機能と、その値を
渡す先の名前だけを書きます。

- `secret.generated`: `kind`、任意の `bytes`（16〜64）、任意の `encoding`（`hex` か `base64url`）、
  `deliver`。module ごとに 8 件まで。
- `http.endpoint`: `kind`、`deliver`。
- `identity.oidc`: `kind`、最上位からのパスで書く `callbackPath`、1〜16 件の `scopes`、`deliver`。
- `interface.consume`（v2.2）: `kind`、module の中で重複しない `key`、正確な `interface.type` と
  `interface.version`、1〜16 件の `permissions`、`{ "type": token }` だけを持つ `delivery`。

`deliver` には `variables` か `bindings` のどちらか一方だけを書きます。渡す先の slot は kind ごとに
決まっていて、値は OpenTofu の変数名か実行時の binding 名（どちらも正確に一致するもの）です。別の
requirement と同じ渡し先は使えません。endpoint は module ごとに 1 件までです。Takosumi が予約している
binding、無い変数や文字列でない変数、運用している人が許可していない kind は、変換のときに拒否されます。

`identity.oidc` は、確認を経た Git の OpenTofu のアプリが、製品や provider に依存せずに求められる、
Takosumi Accounts のサインインの機能です。選んだ module には、`identity.oidc` と `http.endpoint` が
ちょうど 1 件ずつ必要です。OIDC の `deliver` はふつう `variables` で、slot は `accountsUrl`、`issuerUrl`、
`clientId`、`redirectUri` のちょうど 4 つです。v2.4 では `bindings` でも渡せ、その slot は `issuerUrl`、
`clientId`、`ownerSubject`、`redirectUri` のちょうど 4 つです。endpoint は `url` を、別の文字列の変数に
渡します。OIDC の scopes は重複がなく `openid` を含み、データベースに保存された
`InstallConfig.policy.repositoryInstallUx` で明示的に許可された `allowedOidcScopes` の中になければ
なりません。許可の一覧が無いときは、この機能を使えません。

`variables` で渡す場合、変更の確認（Plan）は、endpoint の `url` 変数から、パス、query、fragment、
認証情報を含まない、正規の HTTPS の origin を読めなければ止まります。その origin と確認済みの
`callbackPath` から redirect URI を作り、4 つの変数と権限の digest を、Plan に付ける記録（sidecar）に
固定します。`bindings` で渡す場合（v2.4）は、4 つの値を plan、state、ログに書かず、デプロイ（Apply）の
ときだけ runner に渡します。Plan と `apply_check` は Accounts を変更せず、最後の Apply だけが、その
Capsule に結びついた公開 client を登録します。何度実行しても結果は同じです。最後の destroy のあとの
片付け（retirement）も、何度実行しても結果は同じです。Accounts の機能が使えないときや、origin、変数、
callback、scope、digest が変わったときは、runner を動かす前に失敗します。ProviderBinding、provider の
output、製品名、ホスト名の決まりから推測して補うことはなく、この要求で provider、resource、デプロイ、
lifecycle の権限が増えることもありません。

`interface.consume` には、provider、製品名、Interface の ID、endpoint、認証情報を書きません。Takosumi は、
Plan のあとに保存した InstallConfig から正確な type と version を読み、同じ Workspace に `Resolved` の
Interface がちょうど 1 件あるときだけ、サインインしている Principal に、必要最小限の permissions の通常の
`InterfaceBinding` を作ります。0 件や複数件のとき、取り消された binding や衝突する binding があるとき、
運用している人の policy の外の permission や delivery のときは止まります。実行時の認証情報は短い期限で
発行され、manifest や OpenTofu の変数には書き込まれません。

## `features`

`features` は任意で、最大 32 件です。entry に書けるのは `id`、`optional`、日英の `label`、空でない
`inputs` だけです。`inputs` は同じ module で宣言した利用者の入力を指し、feature どうしで重複できません。
feature は画面の上での入力のまとまりで、provider、resource、lifecycle を有効にする権限はありません。

## `sourceBuild` (v2.3)

v2.3 の module には、checkout した Git の SourceSnapshot に対して OpenTofu の前に行う前処理を、認証情報を
含まない `sourceBuild` として任意で提案できます。リポジトリの情報がそのまま実行されるのではなく、互換性の
確認のあとで利用者が確かめた値として、データベースに保存する `InstallConfig.sourceBuild` に変換されます。
Takosumi 側や運用している人の `baseConfig.sourceBuild` があれば、そちらが常に優先されます。

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

`commands` は 1〜8 件で、各 `argv` は shell の文字列ではなく、空でない 1〜32 個の要素（それぞれ
4,096 文字まで）です。`workingDirectory` と `outputs` は SourceSnapshot の最上位からの安全な相対パスで、
`outputs` には、`.` ではない、作られるパスを 1〜16 件書きます。パスは正規の形で書き、前後の空白、`\\`、
`//`、`.` や `..` の区切りは直さずに拒否します。書ける項目は決まっていて、`env`、認証情報、provider、
lifecycle の項目はありません。argv に秘密らしい値を含めることもできません。

Dashboard は、変更の確認（Plan）を始める前に、正確な argv、作業ディレクトリ（省略時は Source の
最上位）、outputs を表示します。Plan と Run は、取り込んだリポジトリの情報を読み直さず、保存した
InstallConfig だけを使います。

## `interfaces` (v2〜v2.4)

v2〜v2.4 では、module ごとに最大 32 件の、Capsule が提供する Interface を提案できます。v1 に
`interfaces` を書くと無効です。v2.1〜v2.4 は、v2 の Interface の形と変換の規則をそのまま引き継ぎます。
画面をホームに出す完全な例は[ホームにアプリを出す](../getting-started/home-launcher.md)にあります。
この節は Capsule が提供する Interface、`interface.consume` は Capsule が使う Interface を扱います。

各宣言に書けるのは、`key`、`name`、`spec`、任意の `bindingRequests` だけです。`spec` に書けるのは、
`type`、`version`、公開する JSON の `document`、任意の `inputs`、`access` だけです。

- `spec.inputs` は最大 64 件で、公開する JSON の `literal` か、module の Output を `outputName` と
  `outputType` で正確に指す `output` のどちらかです。
- Output は、互換性の確認結果で、あること、`sensitive: false`、`ephemeral: false` を確かめられなければ
  使われません。名前から推測することはありません。
- `access.visibility` は `workspace` だけです。`resourceUriInput` は同じ spec の input 名でなければ
  なりません。Takosumi 側が持つ `policyRef` は書けません。
- `bindingRequests` は最大 1 件です。entry に書けるのは、`key`（必須の token）、
  `{ "source": "installing_principal" }` だけの `subject`、1〜16 件の重複しない `permissions`、`type`
  だけを持つ `delivery` の 4 つだけです。運用している人が permission と delivery の許可の一覧を明示して
  いないと拒否されます。

標準の InstallConfig が許可するのは、追加した本人に対する `ui.open` と `none`、`mcp.invoke` と
`oauth2` の組だけです。これは追加の計画（install plan）の確認を通った、1 回限りの Binding の提案で、
Workspace 全体や運用者の権限を与えるものではありません。ほかの permission や delivery は、運用している
人の InstallConfig で明示的に許可する必要があります。

採用された提案は、既存の `InstallConfig.interfaceBlueprints` と `outputAllowlist` に、変わらない key で
まとめられます。衝突したときは上書きせずに失敗します。追加した Principal を正確に特定し、Interface と
Binding を実際に用意するのは Takosumi 側の通常の処理で、リポジトリが利用許可（grant）を作ることは
できません。

## Authority と secret の境界

manifest に書けるのは、公開してよい提案だけです。次のものは書けません。

- Git URL、ref・tag・commit、SourceSnapshot、ストアの掲載項目、provider・配置先（target）・runner の選択
- 認証情報・秘密・token・password・key の値、認証情報への参照、Principal の ID、account・workspace・
  capsule・resource・connection など Takosumi 側が管理する ID
- 任意の環境変数の注入、`env` の map、provider の割り当て（provider binding）、Interface の利用許可
  （grant）
- lifecycle のコマンド、移行（migration）、公開する Output の一覧（output allowlist）、課金、policy、
  変更の確認やデプロイ（Plan / Run）を飛ばす指定

`secret: true` や `secret.generated` は、値そのものではなく、Takosumi に秘密を用意して渡すよう求める
指定です。公開される表示用の項目（`label`、`helper`、`placeholder`、feature の label）は、`sk-…`、
bearer や代入の形、URI に埋め込んだ認証情報など、よく知られた認証情報らしい形を検査します。Interface の
`document` と literal は、key と値を入れ子まで検査し、秘密らしい値と、Takosumi 側が管理する ID を拒否
します。一方、表示用の文章の中で「token」などの語を使っても、それだけでは拒否しません。ただし、
`Token abc123` のように、大文字で始まる `Token` や `Bearer` などのすぐ後に値を書く形は、文中のどこに
あっても、認証情報らしい形として拒否することがあります。
エラーの説明に値をそのまま書き出すことはありません。これらの公開 JSON の値の入れ子の深さは、Takosumi の
解析処理（parser）が最大 32 に制限します。JSON Schema の形の検査では深さを表せないため、Schema の
`x-takosumi-semanticConstraints` に、Takosumi が確かめる制約として記しています。

保存されている基本の設定（base InstallConfig）と運用している人の policy が、いつも上限です。リポジトリ
の提案で許可の一覧や権限を広げることはできず、Takosumi 側や運用している人の宣言と衝突する提案は、
上書きせずに拒否します。manifest の digest、snapshot、選んだ module、互換性の確認結果が一致しない
ときは、先に進めずに止めます。

## 無効な例

書ける項目が決まっている object に、module を選ぶ項目を足すと無効です。

```json
{
  "apiVersion": "takosumi.com/v2",
  "kind": "Repository",
  "install": {
    "modulePath": "deploy/app",
    "modules": { "deploy/app": { "inputs": [] } }
  }
}
```

正規の形でない module の key も無効です。

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "modules": { "./deploy/app": { "inputs": [] } }
  }
}
```

公開する document に、秘密や Takosumi 側が管理する ID を入れることはできません。

```json
{
  "key": "launcher",
  "name": "example.launcher",
  "spec": {
    "type": "example",
    "version": "1",
    "document": { "credentialId": "credential_123" },
    "access": { "visibility": "workspace" }
  }
}
```

## Migration と versioning

`apiVersion` の値は、書ける項目が決まった schema を表します。既にある版の項目や意味を、後から広げる
ことはありません。v2.1〜v2.3 で公開済みの `defaultModule` は、互換のための目安として残します。v2.2 は
provider に依存しない `interface.consume`、v2.3 は上限があり認証情報を含まない `sourceBuild`、v2.4 は
OIDC の値を実行時の binding で渡す方法を加えた版です。既存の module、提供する Interface、権限の意味は
変えていません。知らない版や項目は受け付けません。互換のない語彙や権限の考え方の変更には、別の schema
の識別子が必要です。

将来 metadata section を追加するときは新しい `apiVersion` を定義し、未知 field は fail closed の
ままにします（知らない項目は、今後も受け付けません）。

- manifest の版にかかわらず、Takosumi が調べた結果、module が 1 つだけ見つかれば、それが自動で
  選ばれます。
- module が複数見つかったリポジトリでは、利用者がフォルダを、その正確な path で選びます。
- v2 の `interfaces` は、v2.1 に上げても同じ形と意味のまま使えます。
- Takosumi 側の Interface を使うリポジトリだけが v2.2 に上げ、`interface.consume` を足します。
- SourceSnapshot の前処理を提案するリポジトリは v2.3 に上げ、module ごとに `sourceBuild` を足します。
- `apiVersion` を上げずに、後の版の項目を v1 や v2 の文書へ足してはいけません。

ストアはこの manifest の代わりにはなりません。TCS 2.0 とのつなぎ方と handoff は
[Store API](./store-api.md)にあります。リポジトリから追加するときの入力は Git URL、ref、任意の module
のフォルダの目安で、module と provider の候補は、固定した SourceSnapshot の OpenTofu を調べた結果から
得ます。
