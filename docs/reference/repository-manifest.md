# Repository manifest

`.well-known/takosumi.json` は、Git repository が同じ commit に固定された
Takosumi 向け metadata を提案するための任意の文書です。repository が所有しますが、
実行権限ではありません。Takosumi は内容を検証し、現在の `install` 宣言を
DB-owned `InstallConfig` に compile してから、通常の compatibility check、
Plan、Apply を行います。

## 現行 wire

```json
{
  "apiVersion": "takosumi.com/v1",
  "kind": "Repository",
  "install": {
    "modules": {
      ".": {
        "inputs": [],
        "requires": []
      }
    }
  }
}
```

root は closed object です。現行 version が受け付けるのは
`apiVersion`、`kind`、`install` だけで、`install` が受け付けるのは
`modules` だけです。`$schema` と旧 install-only
`schemaVersion: takosumi.install-ux/v1` は受け付けません。将来 metadata
section を追加するときは新しい `apiVersion` を定義し、未知 field は
fail closed のままにします。予約用の空 section は置きません。

## `takosumi.com/v2` — Capsule Interface proposal

`takosumi.com/v2` は v1 を解釈し直さず、module ごとに generic な
`interfaces` proposal を追加します。v1 の module に `interfaces` を置くことは
できません。宣言できるのは Interface の `key` / `name` / `spec` と、任意の
`bindingRequests` だけです。

```json
{
  "apiVersion": "takosumi.com/v2",
  "kind": "Repository",
  "install": {
    "modules": {
      "deploy/takoform": {
        "inputs": [],
        "interfaces": [
          {
            "key": "launcher",
            "name": "example.launcher",
            "spec": {
              "type": "interface.ui.surface",
              "version": "1",
              "document": { "launcher": true },
              "inputs": {
                "url": {
                  "source": "output",
                  "outputName": "launch_url",
                  "outputType": "url"
                }
              },
              "access": { "visibility": "workspace" }
            },
            "bindingRequests": [
              {
                "key": "installer",
                "subject": { "source": "installing_principal" },
                "permissions": ["ui.open"],
                "delivery": { "type": "none" }
              }
            ]
          }
        ]
      }
    }
  }
}
```

`spec.inputs` は公開 JSON の `literal`、または exact compatibility report が
記録した module Output を名前と型で参照する `output` だけです。Output の
存在、`sensitive: false`、`ephemeral: false` が report で証明できない場合は
fail closed になります。`launch_url` のような名前を推測して Output を探す
fallback はありません。採用された Output だけが既存の DB-owned
`InstallConfig.outputAllowlist` に `required` projection として追加され、
Interface input は既存の `capsule_output` blueprint に compile されます。

`bindingRequests` は grant ではありません。repository が指定できる subject は
`installing_principal` だけで、permission と delivery は bounded な値として
operator policy の allowlist に照らして審査されます。credential、Principal ID、
provider、target、secret、任意の delivery options は manifest に置けません。
審査・review が成功した後にだけ既存の InstallConfig/Interface materializer が
exact installer Principal を解決し、Apply 後に Interface と Ready Binding を
作ります。manifest は Interface lifecycle や grant の authority ではありません。

v1 の各 module が提案できるのは3つです。`inputs` は module が所有する入力名と
表示文言、`requires` はその application が動くために host に用意してほしい
もの、`features` は任意機能の grouping です。Git source/ref、provider
credential、target、billing、lifecycle command、Interface grant、任意の
環境変数注入は宣言できません。

## requires — 要求であって値ではない

manifest は公開 repository file なので、解決済みの secret や credential が
現れてはいけません。`requires` が宣言するのは「何が要るか」と「どの名前で
受け取りたいか」だけで、値を作って配るのは host です。Takosumi は各要求を
operator policy に照らして検証し、自分の DB-owned `InstallConfig` に compile
してから Plan に渡します。

```json
{
  "kind": "secret.generated",
  "bytes": 32,
  "encoding": "base64url",
  "deliver": { "bindings": { "value": "ENCRYPTION_KEY" } }
}
```

`kind` は `identity.oidc` / `secret.generated` / `http.endpoint` です。

`deliver` は配り先をちょうど1つ選びます。`variables` は入力変数を面に持つ
module system 向け、`bindings` は変数を持たない portable runtime 向けです。
要求そのものはどちらでも同じ形で、違うのは配り先だけです。

`secret.generated` に `variables` はありません。host が secret を portable な
module state に書くことはないからです。逆に `http.endpoint` に `bindings` は
ありません。割り当てられた hostname は注入される値ではなく runtime の場所
そのものだからです。

境界は「host の権能が要るか」です。ただの非機密文字列は module 自身の設定に
書いてください。

## inputs の role

`role` は、その入力が何であるかを installer に伝えます。値の出どころ
(`source`) は変えません。`service_name` はサービス名の欄、`initial_secret`
は初期パスワードの欄で、どちらも module ごとに1つまでです。

## 所有境界

- app repository は `.well-known/takosumi.json` と、その application 語彙を所有します。
- Takosumi は schema/parser、policy、同じ `SourceSnapshot` に対する検証と
  `InstallConfig` compilation を所有します。
- Source sync は exact file 全体の digest と検証状態を
  `SourceSnapshot.repositoryManifest` として保存・公開し、raw document は公開しません。
- DB-owned `InstallConfig` が reviewed Plan/Run の入力です。repository
  manifest を実行時に再読込しません。
- TCS Store listing は discovery と browse 表示だけを所有し、この manifest
  の install 宣言を代行しません。

root の `install-options.json` は別の任意 contract です。
`apiVersion: install.takosumi.com/v1alpha1`、
`kind: CapsuleSourceOptions` を使い、通常の Capsule source 候補を1つ選ぶ
chooserだけを表します。入力や `InstallConfig` を二重宣言してはいけません。
