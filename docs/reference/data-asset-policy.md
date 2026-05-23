# Operator DataAsset Extension Policy {#dataasset-policy}

> このページでわかること: DataAsset のアクセスポリシーとライフサイクル。

本リファレンスは、 current v1 実装で operator が DataAsset extension を mount
する場合の、DataAsset アップロードと runtime-agent consume policy を記録する。

DataAsset は operator extension の operational surface です。route / CLI 名には
historical に `artifact` が残ります。build 後 source は prepared source snapshot
として Installer API に渡し、runtime-agent connector は必要な file を
`preparedSource` から読みます。

## 現行の強制ポイント {#current-enforcement-points}

operator が DataAsset extension を mount した場合、その extension は DataAsset
policy を 3 箇所で強制する。

### DataAsset アップロード {#artifact-upload}

operator が `/v1/artifacts` を有効化した場合、`POST /v1/artifacts` は deploy
bearer を要求する。 `sha256` を計算し、`expectedDigest` を verify し、 size cap
を強制する。

### DataAsset フェッチ {#artifact-fetch}

operator が `/v1/artifacts` を有効化した場合、`GET` または `HEAD` の
`/v1/artifacts/:hash` は deploy bearer と read-only artifact-fetch bearer の
いずれかを受け付ける。

### Runtime-agent apply {#runtime-agent-apply}

DataAsset-backed lifecycle request では dispatcher が operator DataAsset
metadata を connector の `acceptedArtifactKinds` と照合する。source-backed
connector は `preparedSource` と kind-specific `spec` を読む。

---

build / prepare は build service、CI、または operator automation が実行する。
DataAsset routes はアップロード済み blob の保存・取得・GC を扱う。

## サイズポリシー {#size-policy}

global upload cap は `TAKOSUMI_ARTIFACT_MAX_BYTES` で default は `52428800`
バイト。 operator は env を設定するか、 DataAsset route をマウントするときに
`maxBytes` を渡せる。

登録済み DataAsset metadata kind は `maxSize` を持ちうる。 存在する場合、 その
`maxSize` はその metadata kind について route default を上書きする。

```ts
registerArtifactKind({
  kind: "operator.example/log-bundle",
  description: "Operator-owned diagnostic bundle",
  contentTypeHint: "application/gzip",
  maxSize: 50 * 1024 * 1024,
});
```

未知 / 未登録の metadata kind は global cap を使う。 content-length
プリフライトは既知の最大 cap を使い、 post-parse body チェックが submit された
metadata kind に対して厳密な cap を強制する。

Failure mode:

### アップロードが実効上限超過 {#upload-exceeds-effective-cap}

- HTTP / code: `413 resource_exhausted`
- Recovery: `TAKOSUMI_ARTIFACT_MAX_BYTES` を上げる、 より大きい `maxSize` を
  register する、 DataAsset を圧縮する、 R2 / S3 / GCS へ storage を移す

### Digest 不一致 {#digest-mismatch}

- HTTP / code: `400 invalid_argument`
- Recovery: 計算済 digest で re-upload するか、 expected digest を修正

### deploy bearer 不足 {#missing-deploy-bearer}

- HTTP / code: `401 unauthenticated` または public token 未設定時は route `404`
- Recovery: `TAKOSUMI_DEPLOY_TOKEN` を設定

## Accepted DataAsset metadata ポリシー {#accepted-kind-policy}

DataAsset metadata `kind` は operator-owned open metadata です。各 connector は
受け付けるものを宣言します。例:

- DataAsset-backed custom connectors: explicitly registered operator-owned
  metadata kinds
- Source-backed worker / web-service connectors: `acceptedArtifactKinds: []` and
  `preparedSource` + kind-specific `spec`

runtime-agent は connector コードが動く前に mismatch を reject する。reference
component kind レベルの validation はより厳しいことがある。takosumi.com
reference `worker` は `spec.entrypoint` を要求し、DataAsset descriptor
は要求しない。

## 認証ポリシー {#auth-policy}

DataAsset surface は write / read credential を分離する。

- `TAKOSUMI_DEPLOY_TOKEN`: artifact upload、 list、 delete、 GC、 read
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN`: runtime-agent host 向けの read-only `GET` /
  `HEAD /v1/artifacts/:hash`

runtime-agent が apply のために upload された bytes を fetch する場合、read-only
token を受け取る。

## オペレーター surface {#operator-surface}

DataAsset extension を有効化した operator のコントロール:

- `TAKOSUMI_ARTIFACT_MAX_BYTES`: global upload cap
- `registerArtifactKind(..., { allowOverride })`: operator-controlled bootstrap
  / implementation loading 時の discovery metadata と optional per-kind size
  登録
- `takosumi artifact kinds`: read-only discovery for operator metadata
- `takosumi artifact gc`: unreferenced blob の mark-and-sweep cleanup

policy reload command や transform 承認 workflow を追加する場合は、 対応する
対応する reference docs と CLI surface を一緒に更新する。

## 関連ページ

- [Data Assets](./kind-registry.md#source-files-and-data-assets)
- [Connector Guide](./connector-contract.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Environment Variables](./env-vars.md)
- [Audit Events](./audit-events.md)
