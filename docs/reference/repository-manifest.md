# Repository manifest

`.well-known/takosumi.json` は、Git repository が同じ commit に固定された
Takosumi 向け metadata を提案するための任意の文書です。repository が所有しますが、
実行権限ではありません。Takosumi は内容を検証し、現在の `install` 宣言を
DB-owned `InstallConfig` に compile してから、通常の compatibility check、
Plan、Apply を行います。

## 現行 wire

```json
{
  "apiVersion": "takosumi.com/v1alpha1",
  "kind": "Repository",
  "install": {
    "modules": {
      ".": {
        "inputs": []
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

各 module は、その module が所有する入力名、表示文言、対応済みの semantic
projection、任意機能の grouping だけを提案できます。Git source/ref、
provider credential、target、billing、lifecycle command、Interface grant、
任意の環境変数注入は宣言できません。

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
