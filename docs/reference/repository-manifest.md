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

各 module の `inputs` は必須の配列で、最大128件です。各 entry は次の closed field を
持ちます。

| field         | 必須 | 内容                                          |
| ------------- | ---- | --------------------------------------------- |
| `name`        | yes  | exact OpenTofu variable name                  |
| `source`      | yes  | `{ "kind": ... }` のみ                        |
| `label`       | yes  | non-empty な `{ "ja", "en" }`                 |
| `role`        | no   | `service_name` / `initial_secret`             |
| `type`        | no   | `string` / `number` / `boolean` / `json`      |
| `format`      | no   | bounded presentation token                    |
| `required`    | no   | boolean                                       |
| `helper`      | no   | `{ "ja", "en" }`                              |
| `placeholder` | no   | non-empty bounded text                        |
| `advanced`    | no   | boolean                                       |
| `secret`      | no   | user input を secret materialization に送る印 |

`source.kind` は `user`、`capsule_name`、`workspace_scoped_capsule_name`、
`module_default` のいずれかです。`secret: true` は `user` だけ、
`module_default` は `required: true` にできません。`env` のような plain environment
map を secret や `initial_secret` として公開できません。input name と role は module
内で一意で、identifier の前後 whitespace は trim せず canonical でなければ拒否します。
compatibility report が exact variable の存在、型、default の有無を証明できなければ
採用されません。公開 label/helper/placeholder は既知の credential-like material を検査
しますが、「Use a token value」のような通常の prose は許可します。

## `requires`

`requires` は任意、最大16件です。値や credential ではなく、host に必要な機能と
delivery 名だけを提案します。

- `secret.generated`: `kind`, optional `bytes` (16〜64), optional
  `encoding` (`hex` / `base64url`), `deliver`。module ごとに最大8件。
- `http.endpoint`: `kind`, `deliver`。
- `identity.oidc`: `kind`, root-relative `callbackPath`, 1〜16件の `scopes`,
  `deliver`。
- `interface.consume` (v2.2): `kind`, module 内で一意な `key`, exact
  `interface.type` / `interface.version`, 1〜16件の `permissions`,
  `{ "type": token }` だけを持つ `delivery`。

`deliver` は `variables` または `bindings` のちょうど一方を持ちます。slot は kind
ごとに closed で、値は exact OpenTofu variable name または runtime binding name
です。別 requirement と同じ delivery 名を共有できません。endpoint は module ごとに
1件までです。host-reserved binding、存在しない/non-string variable、operator が
許可しない requirement kind は compiler が拒否します。

`identity.oidc` は reviewed Git/OpenTofu app が product/provider に依存せず要求できる
Takosumi Accounts capability です。選択 module はちょうど1件の `identity.oidc` と
ちょうど1件の `http.endpoint` を持たなければなりません。OIDC の `deliver` は
ふつう `variables` で、slot は `accountsUrl`、`issuerUrl`、`clientId`、`redirectUri` の
exact 4件です。v2.4 では `bindings` でも届けられ、その slot は `issuerUrl`、`clientId`、
`ownerSubject`、`redirectUri` の exact 4件です。endpoint は `url` を別の string variable に届けます。OIDC scopes は
重複なしで `openid` を含み、DB-owned `InstallConfig.policy.repositoryInstallUx`
の明示的な `allowedOidcScopes` 内でなければなりません。allowlist がない場合は
capability を許可しません。

variables で届ける場合、Plan は endpoint の `url` variable から、path、query、fragment、
credential のない canonical な exact HTTPS origin を読めなければ fail closed です。その origin と
review 済み `callbackPath` から redirect URI を導出し、exact 4 variables と authority
digest を Plan sidecar に固定します。bindings で届ける場合（v2.4）は、4 つの値を plan、state、
log に書かず、Apply のときだけ runner に渡します。Plan と `apply_check` は Accounts を変更せず、
final Apply だけが Capsule-bound public client を何度実行しても結果が同じ形で登録できます。terminal
destroy 後の retirement も、何度実行しても結果は同じです。Accounts capability が利用できない、
origin/variable/callback/scope/digest が drift した場合は runner 実行前に失敗します。
ProviderBinding、provider output、製品名、hostname 規則からの fallback/inference はなく、
この request は provider/resource/deployment/lifecycle authority を追加しません。

`interface.consume` は provider、製品名、Interface ID、endpoint、credential を宣言
しません。host は Plan 後の DB-owned InstallConfig から exact type/version を読み、同じ
Workspace にある `Resolved` Interface がちょうど1件の場合だけ、認証済み Principal に
最小 permissions の通常の `InterfaceBinding` を作ります。0件または
複数件、revoked/conflicting binding、operator policy 外の permission/delivery は
fail closed です。runtime credential は短期発行され、manifest や OpenTofu variable へ
書き込みません。

## `features`

`features` は任意、最大32件です。entry は `id`, `optional`, bilingual `label`,
non-empty `inputs` だけを持ちます。`inputs` は同じ module に宣言した user input を
参照し、feature 間でも重複できません。feature は UI grouping であり、provider、
resource、lifecycle を有効化する authority ではありません。

## `sourceBuild` (v2.3)

v2.3 の module は、Git SourceSnapshot の checkout 前処理を行う任意の
credential-free `sourceBuild` proposal を持てます。これは repository metadata の
実行権限ではなく、exact compatibility review 後に DB-owned `InstallConfig.sourceBuild`
へ compile される user-reviewed 値です。既存の service/operator `baseConfig.sourceBuild`
があれば repository proposal より常に優先されます。

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

`commands` は1〜8件、各 `argv` は shell string ではない1〜32個の non-empty argv
要素（各4096文字以内）です。`workingDirectory` と `outputs` は SourceSnapshot
root からの safe relative path で、outputs は1〜16件かつ `.` ではない produced
path を指定します。path は canonical form が必須で、前後の空白、`\\`、`//`、
`.` / `..` segment を正規化せず拒否します。object は closed で、`env`、credential、provider、lifecycle
field はありません。argv に secret-like material を含めることもできません。

Dashboard は Plan を開始する前に exact argv、working directory（省略時は Source
root）、outputs を表示します。Plan/Run は captured repository metadata を再読込せず、
persist 済み InstallConfig だけを使います。

## `interfaces` (v2〜v2.4)

v2、v2.1、v2.2、v2.3、v2.4 は module ごとに最大32件の generic Capsule Interface
proposal を追加できます。v1 に `interfaces` を置くと invalid です。v2.1〜v2.4 は v2 の
Interface schema と compiler semantics をそのまま保持します。画面をホームに出す完全な例は
[ホームにアプリを出す](../getting-started/home-launcher.md)にあります。この section は
Capsule が提供する Interface、`interface.consume` は Capsule が利用する Interface です。

各 declaration は `key`, `name`, `spec`, optional `bindingRequests` だけを持ちます。
`spec` は `type`, `version`, public JSON `document`, optional `inputs`, `access` の
closed object です。

- `spec.inputs` は最大64件で、public JSON の `literal` または exact module Output の
  `outputName` と `outputType` を指定する `output` だけです。
- Output は compatibility report が存在、`sensitive: false`,
  `ephemeral: false` を証明しなければ採用されません。名前の推測はありません。
- `access.visibility` は `workspace` 固定です。`resourceUriInput` は同じ spec の
  input 名でなければなりません。host-owned `policyRef` は指定できません。
- `bindingRequests` は最大1件です。entry は `key`（必須の token）、
  `{ "source": "installing_principal" }` だけの `subject`、1〜16件の重複しない
  `permissions`、`type` だけを持つ `delivery` の 4 つだけを持ちます。operator の明示的な
  permission/delivery allowlist が無い場合は拒否されます。

generic default InstallConfig が許可するのは、installer本人に対する
`ui.open` + `none` と `mcp.invoke` + `oauth2` だけです。これはinstall-planの
reviewを通った一回限りのBinding proposalであり、Workspace全体やoperator権限を
付与しません。その他のpermission/deliveryはoperator-owned InstallConfigで明示的に
許可する必要があります。

採用された proposal は既存の `InstallConfig.interfaceBlueprints` と
`outputAllowlist` に stable key で merge されます。conflict は上書きせず失敗します。
exact installing Principal の解決と Interface/Binding materialization は既存 host
lifecycle が行い、repository は grant を作れません。

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
