# Capsule Source Options

`CapsuleSourceOptions` は、1 本の install link から複数の通常の Git Capsule source を提示するための、任意の公開 JSON 文書です。Takosumi 専用 source manifest、構成 DSL、依存関係 graph ではありません。候補を選んだ後は必ず通常の `/new` に移り、Source 認証、compatibility check、Provider Binding、Plan、Apply を同じ経路で行います。

## Install link

```text
https://<operator>/install?kind=capsule-source-options&git=<document-git-url>&path=<document-path>[&ref=<explicit-git-ref>]
```

- `git` は credential を埋め込まない public HTTPS Git URL です。
- `path` は repository 内の安全な相対 JSON path です。
- `ref` を指定した場合は、その値を通常の Git ref として exact source sync します。
- `ref` を省略した場合、runner は `git ls-remote --tags` で最も新しい stable SemVer tag を解決します。`vX.Y.Z` と `X.Y.Z` だけを認め、prerelease、build metadata、HEAD、default branch、forge API へ fallback しません。同じ version に `vX.Y.Z` と `X.Y.Z` が両方ある場合は曖昧として失敗します。

tag resolver は tag と immutable commit だけを返します。chooser は commit を Source sync に使うため、tag が後から動いても読み取る文書は変わりません。

## Closed document

```json
{
  "apiVersion": "install.takosumi.com/v1alpha1",
  "kind": "CapsuleSourceOptions",
  "metadata": {
    "name": "example-starters",
    "title": "追加するサービスを選択",
    "description": "必要なものを 1 つ選びます。"
  },
  "options": [
    {
      "id": "basic",
      "title": "Basic",
      "source": {
        "url": "https://github.com/example/basic.git",
        "path": "deploy/opentofu"
      }
    },
    {
      "id": "advanced",
      "title": "Advanced",
      "source": {
        "url": "https://github.com/example/advanced.git",
        "ref": "v2.1.0",
        "path": "."
      }
    }
  ]
}
```

`options` は 1〜32 件、`id` は文書内で一意です。root、metadata、option、source は closed object で、未知 field を拒否します。credential、provider config、region、pricing、capacity、Interface、dependency、policy、自動 install 宣言は含められません。選択した option の `ref` が省略されている場合も、同じ stable SemVer resolver で immutable commit に固定してから `/new` へ渡します。

## Immutable evidence and API

chooser は Source sync で作った exact `SourceSnapshot` から 128 KiB 以下の regular UTF-8 JSON file を runner 境界で読み、次を表示します。

- 文書の Git URL、要求 ref または解決 tag
- immutable commit と file path
- file の exact bytes に対する `sha256:` digest と byte size

account session API は次の 2 endpoint を提供します。

```text
POST /api/v1/workspaces/:workspaceId/source-ref-resolutions/stable-semver
GET  /api/v1/sources/:sourceId/snapshots/:sourceSnapshotId/file?path=...
```

どちらも認証と Workspace authorization が必要です。operator bearer の internal seam は同じ末尾を `/internal/v1` で提供します。file reader は Source と SourceSnapshot の ownership を確認し、path traversal、symlink、非 regular file、上限超過、invalid UTF-8 を拒否します。
