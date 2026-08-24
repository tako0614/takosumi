# Repository manifest

`.well-known/takosumi.json` は、Git repository が同じ commit に固定された
install metadata を Takosumi に提案するための任意文書です。repository が所有しますが、
実行権限ではありません。Source sync は repository root の文書を最大 128 KiB の
UTF-8 JSON として検証し、結果と digest を immutable
`SourceSnapshot.repositoryManifest` に保存します。raw document は public API に
返しません。

Takosumi は exact SourceSnapshot の宣言を compatibility report と照合し、operator
policy の範囲内で DB-owned `InstallConfig` に compile します。Plan/Run が読むのは
persist 済み InstallConfig であり、manifest を実行時に再読込しません。

## Version と closed object

すべての version で root は次の3 fieldだけを持ちます。

```json
{
  "apiVersion": "takosumi.com/v2.3",
  "kind": "Repository",
  "install": {}
}
```

| `apiVersion`        | `install` の field          | module の field                             |
| ------------------- | --------------------------- | ------------------------------------------- |
| `takosumi.com/v1`   | `modules`                   | `inputs`, `requires`, `features`            |
| `takosumi.com/v2`   | `modules`                   | v1 + `interfaces`                           |
| `takosumi.com/v2.1` | `modules`, `defaultModule`? | v2 と同一                                   |
| `takosumi.com/v2.2` | `modules`, `defaultModule`? | v2.1 + `requires[].kind: interface.consume` |
| `takosumi.com/v2.3` | `modules`, `defaultModule`? | v2.2 + optional `sourceBuild`               |

各 object は closed です。表や各 section にない field、`$schema`、旧
`schemaVersion: takosumi.install-ux/v1` は拒否されます。v1/v2 に
`defaultModule` を追加しても v2.1 として解釈されません。

公開 JSON Schema は
[`repository-manifest-v2.1.schema.json`](/schemas/repository-manifest-v2.1.schema.json) と
[`repository-manifest-v2.2.schema.json`](/schemas/repository-manifest-v2.2.schema.json) と
[`repository-manifest-v2.3.schema.json`](/schemas/repository-manifest-v2.3.schema.json)
です。これは structural schema であり、JSON Schema と parser の完全な同値性を
意味しません。cross-field uniqueness、`defaultModule` と動的 key の一致、JSON
recursive depth（最大32）、下記の secret/authority vocabulary 検査は canonical
parser が追加で fail closed に検査します。

## Module path と default 選択

`install.modules` は1〜32件です。key は `.` または最大 1,024 文字の canonical な
repository-relative path です。absolute path、`./` prefix、drive prefix、末尾 `/`、
backslash、NUL、空 segment、`.` / `..` segment は使えません。

Store install の `compileInstallUx` では client や Store は `modulePath` を送りません。
Source sync 後、server が exact SourceSnapshot の manifest だけから次の規則で選び、
その path の compatibility check を実行してから derived InstallConfig に同じ値を
保存します。

直接 Git と repository-owned source option は `compileInstallUx` を同じく使用し、
選択済みの `modulePath` を送れます。その path は exact SourceSnapshot manifest の
`install.modules` key として検証され、Store metadata は実行選択に関与しません。

1. `modules` が1件なら、その唯一の key を選ぶ。
2. 複数なら `takosumi.com/v2.1`、`takosumi.com/v2.2`、または `takosumi.com/v2.3` の
   `install.defaultModule` が必須。
3. `defaultModule` は canonical path かつ `modules` の own key と byte-for-byte で
   一致しなければならない。

`.`、JSON object の先頭 key、`.well-known/tcs.json` の path、`Source.defaultPath`、
base `InstallConfig.modulePath` を fallback として推測しません。missing/invalid default
は typed diagnostic で compatibility 実行前に失敗します。manifest がない通常の
plain Git repository も、利用者が明示した `modulePath` を引き続き使用できます。

### 有効な v2.1 multi-module 例

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "defaultModule": "deploy/takoform",
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
- `interface.consume` (v2.2): `kind`, module 内で一意な `key`, exact
  `interface.type` / `interface.version`, 1〜16件の `permissions`,
  `{ "type": token }` だけを持つ `delivery`。

`deliver` は `variables` または `bindings` のちょうど一方を持ちます。slot は kind
ごとに closed で、値は exact OpenTofu variable name または runtime binding name
です。別 requirement と同じ delivery 名を共有できません。endpoint は module ごとに
1件までです。host-reserved binding、存在しない/non-string variable、operator が
許可しない requirement kind は compiler が拒否します。Capsule 固有の
`identity.oidc` materialization は current Git-owned install flow では拒否されます。

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

## `interfaces` (v2 / v2.1 / v2.2 / v2.3)

v2、v2.1、v2.2、v2.3 は module ごとに最大32件の generic Capsule Interface proposal を
追加できます。v1 に `interfaces` を置くと invalid です。v2.1 と v2.2 は v2 の
Interface schema と compiler semantics をそのまま保持します。この section は
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
- `bindingRequests` は最大1件です。subject は `installing_principal` のみ、permission
  は1〜16件、delivery は `{ "type": token }` だけです。operator の明示的な
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

manifest に置けるのは公開 proposal だけです。次を置くことはできません。

- Git URL、ref/tag/commit、SourceSnapshot、Store listing、provider/target/runner 選択。
- credential/secret/token/password/key の値、credential reference、Principal ID、
  account/workspace/capsule/resource/connection など host authority の ID。
- arbitrary environment injection、plain `env` map、provider binding、Interface grant。
- lifecycle command、migration、output allowlist、billing、policy、Plan/Run bypass。

`secret: true` や `secret.generated` は値ではなく host materialization の要求です。
公開 presentation field（`label`、`helper`、`placeholder`、feature label）は
`sk-…`、bearer/assignment、URI credential など既知の
credential-like pattern を検査します。Interface `document` と literal は key/value を
再帰検査し、secret-like material と authority ID を拒否します。普通の prose の
「token」などはこの方針で過剰拒否しません。diagnostic は値を echo しません。これらの
public JSON value は parser で recursive depth 32 に制限され、JSON Schema はこの
parser-owned 制約を semantic constraint として記録します。

base InstallConfig と operator policy は常に ceiling です。repository proposal は
allowlist や authority を広げず、service/operator 宣言と衝突する proposal は
上書きせず拒否されます。
manifest digest、snapshot、selected module、compatibility report が一致しない場合は
fail closed です。

## 無効な例

v2 に v2.1 field を足しても無効です。

```json
{
  "apiVersion": "takosumi.com/v2",
  "kind": "Repository",
  "install": {
    "defaultModule": "deploy/app",
    "modules": { "deploy/app": { "inputs": [] } }
  }
}
```

存在しない key や alias も無効です。

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "defaultModule": "./deploy/app",
    "modules": { "deploy/app": { "inputs": [] } }
  }
}
```

公開 document に secret/authority を埋め込めません。

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

version identifier は closed schema の識別子です。既存 version の field set や意味を
後から広げません。v2.1 は optional `install.defaultModule`、v2.2 は provider-neutral な
`interface.consume`、v2.3 は bounded credential-free `sourceBuild` だけを追加する
additive schema revision です。既存の module、
provided Interface、authority semantics は変えません。未知 version/field は fail closed
です。incompatible vocabulary や authority model の変更には別の schema identifier が
必要です。

将来 metadata section を追加するときは新しい `apiVersion` を定義し、未知 field は
fail closed のままにします。

- v1/v2 の single-module repository はそのまま利用でき、唯一の key が選ばれます。
- multi-module repository は v2.1 に上げ、exact `defaultModule` を追加します。
- v2 の `interfaces` は v2.1 へ変更しても同じ形・意味で保持されます。
- host Interface を利用する repository だけが v2.2 に上げ、
  `interface.consume` を追加します。
- SourceSnapshot の前処理を提案する repository は v2.3 に上げ、module ごとに
  `sourceBuild` を追加します。
- v1/v2 の文書に field だけ backport してはいけません。

Store はこの manifest を代理しません。TCS 2.0 との接続と URL-only handoff は
[Store API](./store-api.md)を参照してください。root の `install-options.json` は
`apiVersion: install.takosumi.com/v1alpha1`、`kind: CapsuleSourceOptions` を使って
通常の Capsule source 候補を選ぶ別 contract であり、inputs や InstallConfig を
二重宣言できません。
