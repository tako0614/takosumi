# DataAsset Policy

> このページでわかること: DataAsset のアクセスポリシーとライフサイクル。

本リファレンスは、 current v1 実装で Takosumi が DataAsset アップロードと
runtime-agent consume について強制する policy を記録する。

## Current Enforcement Points

Takosumi v1 は DataAsset policy を 3 箇所で強制する。

### Artifact upload

`POST /v1/artifacts` は deploy bearer を要求する。 `sha256` を計算し、
`expectedDigest` を verify し、 size cap を強制する。

### Artifact fetch

`GET` / `HEAD /v1/artifacts/:hash` は deploy bearer と read-only artifact-fetch
bearer のいずれかを受け付ける。

### Runtime-agent apply

lifecycle dispatcher は `spec.artifact.kind` を connector の
`acceptedArtifactKinds` と照合する。

---

kernel は current public deploy path でユーザー build ステップを実行せず、
transform も実行しない。 source transform、 artifact signing policy、 cache
warming に関する将来計画は、 対応する operator API と test が存在するまで
アクティブな CLI / HTTP 動作として文書化しない。

## Size Policy

global upload cap は `TAKOSUMI_ARTIFACT_MAX_BYTES` で default は `52428800`
バイト。 operator は env を設定するか、 artifact route をマウントするときに
`maxBytes` を渡せる。

登録済み artifact kind は `maxSize` を持ちうる。 存在する場合、 その `maxSize`
はその kind について route default を上書きする。

```ts
registerArtifactKind({
  kind: "js-bundle",
  description: "ESM JavaScript bundle",
  contentTypeHint: "application/javascript",
  maxSize: 50 * 1024 * 1024,
});
```

未知 / 未登録の kind は global cap を使う。 content-length プリフライトは既知の
最大 cap を使い、 post-parse body チェックが submit された kind に対して厳密な
cap を強制する。

Failure mode:

### Upload exceeds effective cap

- HTTP / code: `413 resource_exhausted`
- Recovery: `TAKOSUMI_ARTIFACT_MAX_BYTES` を上げる、 より大きい `maxSize` を
  register する、 artifact を圧縮する、 R2 / S3 / GCS へ storage を移す

### Digest mismatch

- HTTP / code: `400 invalid_argument`
- Recovery: 計算済 digest で re-upload するか、 expected digest を修正

### Missing deploy bearer

- HTTP / code: `401 unauthenticated` または public token 未設定時は route `404`
- Recovery: `TAKOSUMI_DEPLOY_TOKEN` を設定

## Accepted-Kind Policy

`Artifact.kind` は protocol 層では open だが、 各 connector は受け付けるものを
宣言する。 例:

- OCI-backed web-service connectors: `oci-image`
- Cloudflare Workers / Deno Deploy: `js-bundle`
- Operator-installed custom connectors: 明示的に宣言した registered or custom
  kind

runtime-agent は connector コードが動く前に mismatch を reject する。 Shape
レベルの validation はより厳しいことがある: `worker@v1` は `hash` 付きの
`js-bundle` のみを受け付ける。

## Auth Policy

artifact surface は意図的に write / read credential を分離する。

- `TAKOSUMI_DEPLOY_TOKEN`: upload、 list、 delete、 GC、 read
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN`: runtime-agent host 向けの read-only `GET` /
  `HEAD /v1/artifacts/:hash`

runtime-agent は apply のために upload された bytes を fetch するだけで済む
場合、 read-only token を受け取る。 deploy bearer は不要であるべきだ。

## Operator Surface

current の operator コントロール:

- `TAKOSUMI_ARTIFACT_MAX_BYTES`: global upload cap
- `registerArtifactKind(..., { allowOverride })`: operator-controlled bootstrap
  / plugin loading 時の discovery metadata と optional per-kind size 登録
- `takosumi artifact kinds`: read-only discovery
- `takosumi artifact gc`: unreferenced blob の mark-and-sweep cleanup

現在 `takosumi policy artifact ...` コマンドは無い。 policy reload command、
transform 承認 workflow、 署名検証 backend を追加するには、 対応する実装、
test、 本リファレンスの更新が必要となる。

## 関連ページ

- [DataAsset Kinds](/reference/artifact-kinds)
- [Connector Contract](/reference/connector-contract)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Environment Variables](/reference/env-vars)
- [Audit Events](/reference/audit-events)
