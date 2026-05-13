# DataAsset Kinds

> このページでわかること: DataAsset の kind 一覧と各 kind の用途。

Takosumi の artifact は DataAsset を裏付ける content-addressed な bytes /
pointer レコードである。Manifest resource が参照する `Artifact` は `kind` と、
`hash` (`POST /v1/artifacts` が返す `sha256:<hex>`) または `uri` (OCI registry
URL のような外部 pointer) のいずれかを持つ。

`Artifact.kind` は **protocol レベルでは open string** である。同梱の kernel は
下記の kind を登録するため、`GET /v1/artifacts/kinds` や
`takosumi artifact
kinds` から、deploy された kernel と runtime-agent connector
集合が認識する 種別を operator に見せることができる。サードパーティの connector
は `registerArtifactKind` で追加の kind を登録できる。registry は discovery
surface であって、hard-coded された public enum ではない。

## Bundled Kinds

同梱の Takosumi プラグインは次の 5 種類を登録する。

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

| Kind            | Description                                                                               | Typical reference                                         | Kernel storage                       |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| `oci-image`     | OCI / Docker container image referenced by registry URI.                                  | `artifact: { kind: "oci-image", uri: "ghcr.io/..." }`     | pointer only; bytes stay in registry |
| `js-bundle`     | ESM JavaScript bundle for serverless runtimes such as Cloudflare Workers and Deno Deploy. | `artifact: { kind: "js-bundle", hash: "sha256:..." }`     | content-addressed upload             |
| `lambda-zip`    | AWS Lambda deployment zip for connectors that consume zipped function packages.           | `artifact: { kind: "lambda-zip", hash: "sha256:..." }`    | content-addressed upload             |
| `static-bundle` | Static site archive for Pages-style hosts.                                                | `artifact: { kind: "static-bundle", hash: "sha256:..." }` | content-addressed upload             |
| `wasm`          | WebAssembly module bytes for connectors that execute or attach WASM artifacts.            | `artifact: { kind: "wasm", hash: "sha256:..." }`          | content-addressed upload             |

`worker@v1` は protocol よりも意図的に厳しい: shape validation は
`artifact.kind: "js-bundle"` と空でない `hash` を要求する。`web-service@v1` は
current canonical shorthand として `image` を受け付け、provider request では
`artifact: { kind: "oci-image", uri: image }` と同じ意味に正規化される。他の
artifact kind は、選ばれた connector が `acceptedArtifactKinds` で宣言したときに
限り有効である。

## Connector Enforcement

runtime-agent connector は `acceptedArtifactKinds` ベクトルを宣言する。
runtime-agent lifecycle dispatcher は、`spec.artifact.kind` の artifact kind が
そのベクトルに含まれない apply request を reject する。これにより protocol
拡張を open に保ちつつ、具体的な connector 境界で fail-closed する。

例:

- Cloudflare Workers / Deno Deploy worker connector は `js-bundle`
  を受け入れる。
- OCI-backed の web-service connector は `oci-image` を受け入れる。
- 将来の / operator がインストールする connector は `lambda-zip`、
  `static-bundle`、`wasm`、または登録済み独自種を受け入れうる。

## Registration API

contract パッケージは `GET /v1/artifacts/kinds` を裏付ける process global な
registry を公開する。

```ts
import {
  getArtifactKind,
  isArtifactKindRegistered,
  listArtifactKinds,
  registerArtifactKind,
  unregisterArtifactKind,
} from "takosumi-contract";

registerArtifactKind({
  kind: "js-bundle",
  description: "ESM JavaScript bundle for serverless runtimes",
  contentTypeHint: "application/javascript",
  maxSize: 50 * 1024 * 1024,
});
```

シグネチャ:

```ts
registerArtifactKind(
  kind: RegisteredArtifactKind,
  options?: { allowOverride?: boolean },
): RegisteredArtifactKind | undefined;

listArtifactKinds(): readonly RegisteredArtifactKind[];
getArtifactKind(kind: string): RegisteredArtifactKind | undefined;
isArtifactKindRegistered(kind: string): boolean;
unregisterArtifactKind(kind: string): boolean;
```

衝突時の挙動:

- ある `kind` の最初の登録は成功し `undefined` を返す。
- 同一メタデータでの 2 回目の登録は silent no-op。
- メタデータが異なり `allowOverride: false` の 2 回目の登録は警告を出し、元の
  レコードを残す。
- `allowOverride: true` の 2 回目の登録はレコードを置き換え、以前のものを返す。
  この path は operator 管理の bootstrap や plugin loader 文脈に予約される。

## Size Limits

artifact route は `TAKOSUMI_ARTIFACT_MAX_BYTES` をグローバルに強制する。
登録済み kind が `maxSize` を持つ場合、その per-kind 値がその kind の upload
について route default を上書きする。未知 / 未登録の kind は global cap に
フォールバックする。

deploy route も plan / apply 副作用の前に manifest 宣言の artifact size を
強制する。resource が `spec.artifact.size` を含むとき、その値はバイト数として
解釈され、登録済み kind の `maxSize` (未知 kind は global cap) を超えない
非負整数でなければならない。これは OCI image URI のような外部 pointer に対する
provider 前の quota gate である。`POST /v1/artifacts` 経由でアップロードされた
content は artifact upload route で再度チェックされる。

`oci-image` は通常 `uri` を使うため、`takosumi artifact push` は不要である。
upload された各 kind は kernel object-storage アダプタ経由で
`<bucket>/artifacts/<sha256-hex>` の下に保存される。client 側の `expectedDigest`
field の有無にかかわらず、digest は server 側で計算・検証される。

## Upload Flow

```text
takosumi artifact push <file> --kind <kind>
  POST /v1/artifacts (multipart: kind, body, metadata, expectedDigest?)
    -> kernel computes sha256 and enforces the global / registered size cap
    -> kernel writes bucket/artifacts/<hex> via ObjectStoragePort
    -> kernel returns { hash, kind, size, uploadedAt, metadata }

manifest.spec.artifact:
  kind: js-bundle
  hash: sha256:abc123...

kernel apply
  -> POST /v1/lifecycle/apply { spec, artifactStore: { baseUrl, token } }
  -> connector verifies acceptedArtifactKinds
  -> connector fetches bytes by hash via artifactStore
  -> connector materializes the resource and returns a handle
```

認証境界:

- 書き込み endpoint (`POST /v1/artifacts`、`DELETE /v1/artifacts/:hash`、
  `POST /v1/artifacts/gc`) は deploy bearer を要求する。
- 読み込み endpoint (`GET /v1/artifacts/:hash`、`HEAD /v1/artifacts/:hash`) は
  `TAKOSUMI_ARTIFACT_FETCH_TOKEN` も受け付けるので、runtime-agent は deploy
  bearer を保持せずに bytes を取得できる。

## Discovery and CLI

```bash
takosumi artifact push ./worker.js --kind js-bundle --metadata entrypoint=index.js
takosumi artifact list
takosumi artifact kinds --table
takosumi artifact gc --dry-run
takosumi artifact rm sha256:abc123...
```

`takosumi artifact kinds` は呼び出し時点で kernel が公開する registry の
snapshot を反映する。registry を変更することはない。

## 関連ページ

- [Connector Contract](/reference/connector-contract)
- [DataAsset Policy](/reference/data-asset-policy)
- [Closed Enums](/reference/closed-enums)
