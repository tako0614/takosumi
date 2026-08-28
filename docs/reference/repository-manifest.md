# Repository manifest

`.well-known/takosumi.json` は任意の repository manifest です。scan で発見された実在の
OpenTofu module に input 表示 hint を追加し、Takosumi が提供する generic API/service の
request と exact delivery target を宣言します。Git repository が executable source と同じ
commit に固定して所有しますが、module path、provider、Connection、resource、deployment、
lifecycle の実行権限ではありません。文書がない plain Git/OpenTofu app も通常どおり
install できます。Source sync は repository root の文書を
最大 128 KiB の UTF-8 JSON として検証し、結果と digest を immutable
`SourceSnapshot.repositoryManifest` に保存します。raw document は public API に返しません。

Git URL、ref、Source subtree と exact commit の tracked regular file scan が
module/provider 候補の正本です。app-owned Git/OpenTofu configuration が
infrastructure/lifecycle authority であり続けます。
Takosumi は accepted generic API/capability の実装を所有し、manifest はその request と
app-owned module への delivered value mapping だけを宣言します。

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

| `apiVersion`        | `install` の field | module の field                             |
| ------------------- | ------------------ | ------------------------------------------- |
| `takosumi.com/v1`   | `modules`          | `inputs`, `requires`, `features`            |
| `takosumi.com/v2`   | `modules`          | v1 + `interfaces`                           |
| `takosumi.com/v2.1` | `modules`, optional `defaultModule` | v2 と同一                                   |
| `takosumi.com/v2.2` | `modules`, optional `defaultModule` | v2.1 + `requires[].kind: interface.consume` |
| `takosumi.com/v2.3` | `modules`, optional `defaultModule` | v2.2 + optional `sourceBuild`               |
| `takosumi.com/v2.4` | `modules`          | v2.3 + runtime OIDC binding delivery        |

各 object は closed です。表や各 section にない field、`$schema`、旧
`schemaVersion: takosumi.install-ux/v1` は拒否されます。

公開 JSON Schema は
[`repository-manifest-v2.1.schema.json`](/schemas/repository-manifest-v2.1.schema.json) と
[`repository-manifest-v2.2.schema.json`](/schemas/repository-manifest-v2.2.schema.json) と
[`repository-manifest-v2.3.schema.json`](/schemas/repository-manifest-v2.3.schema.json) と
[`repository-manifest-v2.4.schema.json`](/schemas/repository-manifest-v2.4.schema.json)
です。これは structural schema であり、JSON Schema と parser の完全な同値性を
意味しません。cross-field uniqueness、JSON recursive depth（最大32）、下記の
secret/authority vocabulary 検査は canonical parser が追加で fail closed に検査します。

## Scanned module と manifest entry

`install.modules` は1〜32件です。key は `.` または最大 1,024 文字の canonical な
repository-relative path です。absolute path、`./` prefix、drive prefix、末尾 `/`、
backslash、NUL、空 segment、`.` / `..` segment は使えません。ただし、entry は exact
`SourceSnapshot` の scan が同じ path に module を発見した場合だけ hint/request として
採用されます。manifest は module を作成、選択、上書きできません。

認証済みの
`GET /api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/install-modules` projection は
`status`、exact `sourceSnapshotId`、`scopePath`、scan 由来の
`modules: [{ path, providerPackages, rootProviderRequirements }]` を返します。
`providerPackages` は到達可能な provider package 全体（policy / lock / mirror 用）、
`rootProviderRequirements` は選択 root が直接要求する exact local-name / alias tuple
（binding / root generation 用）です。dashboard はこの候補から module を選び、
compatibility を実行します。直接 Git と Store は同じ Git URL/ref と optional module path
hint の flow を使い、Store metadata や DB-owned deployment profile は module、provider、
policy を選びません。

候補が1件なら dashboard が自動選択し、複数なら利用者が選択します。manifest にだけある
path は候補にならず、URL で明示された `path` も immutable scan result に存在しなければ
typed 4xx で fail closed します。manifest が absent でも scan された module は利用できます。
任意の manifest が malformed/invalid な場合も、その内容を推測・部分採用せず assistance を
無効化し、scan 由来の generic install を続行します。operator の Host policy が exact manifest
API version を明示的に必須化した場合だけ、absent/invalid/version mismatch を fail closed に
します。この endpoint は account-session 認証、Source Workspace access、SourceSnapshot と
Source の exact relation を検証します。

公開済み v2.1〜v2.3 の optional `install.defaultModule` は引き続き parse され、
`install.modules` の exact key であることを検証しますが、互換表示 hint に限定されます。
scan が複数 module を発見した場合の利用者選択を省略せず、実行 module authority にはなりません。

v1 の scan は immutable archive 内の tracked regular files と vendored local module edge
（`./` / `../`）だけを辿ります。remote module source は pinned/unpinned を問わず network
fetch authority を持たず、候補を部分的に公開せず `invalid` になります。利用する dependency
は repository tree に vendor してください。

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
`variables` だけで、slot は `accountsUrl`、`issuerUrl`、`clientId`、`redirectUri` の
exact 4件です。endpoint は `url` を別の string variable に届けます。OIDC scopes は
重複なしで `openid` を含み、DB-owned `InstallConfig.policy.repositoryInstallUx`
の明示的な `allowedOidcScopes` 内でなければなりません。allowlist がない場合は
capability を許可しません。

Plan は endpoint の `url` variable から、path、query、fragment、credential のない
canonical な exact HTTPS origin を読めなければ fail closed です。その origin と
review 済み `callbackPath` から redirect URI を導出し、exact 4 variables と authority
digest を Plan sidecar に固定します。Plan と `apply_check` は Accounts を変更せず、
final Apply だけが Capsule-bound public client を idempotent に登録できます。terminal
destroy 後の retirement も idempotent です。Accounts capability が利用できない、
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

closed object に module 選択 field を足しても無効です。

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

non-canonical module key も無効です。

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "modules": { "./deploy/app": { "inputs": [] } }
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
後から広げません。v2.1〜v2.3 の公開済み `defaultModule` wire は互換 hint として保持します。
v2.2 は provider-neutral な `interface.consume`、v2.3 は bounded credential-free
`sourceBuild`、v2.4 は runtime OIDC binding delivery を持ちます。既存の module、
provided Interface、authority semantics は変えません。未知 version/field は fail closed
です。incompatible vocabulary や authority model の変更には別の schema identifier が
必要です。

将来 metadata section を追加するときは新しい `apiVersion` を定義し、未知 field は
fail closed のままにします。

- manifest の version にかかわらず、scan で1件だけ見つかった module は自動選択されます。
- scan で複数 module が見つかった repository は利用者が exact path を選択します。
- v2 の `interfaces` は v2.1 へ変更しても同じ形・意味で保持されます。
- host Interface を利用する repository だけが v2.2 に上げ、
  `interface.consume` を追加します。
- SourceSnapshot の前処理を提案する repository は v2.3 に上げ、module ごとに
  `sourceBuild` を追加します。
- v1/v2 の文書に field だけ backport してはいけません。

Store はこの manifest を代理しません。TCS 2.0 との接続と URL-only handoff は
[Store API](./store-api.md)を参照してください。repository install の入力は Git URL、ref、
optional module path hint であり、module/provider 候補は exact SourceSnapshot の
OpenTofu scan から得ます。
