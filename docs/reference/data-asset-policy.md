# DataAsset ポリシー {#dataasset-policy}

> このページでわかること: DataAsset のアクセスポリシーとライフサイクル。

本リファレンスは、 current v1 実装で Takosumi が DataAsset アップロードと
runtime-agent consume について強制する policy を記録する。

## 現行の強制ポイント {#current-enforcement-points}

Takosumi v1 は DataAsset policy を 3 箇所で強制する。

### Artifact アップロード {#artifact-upload}

`POST /v1/artifacts` は deploy bearer を要求する。 `sha256` を計算し、
`expectedDigest` を verify し、 size cap を強制する。

### Artifact フェッチ {#artifact-fetch}

`GET` / `HEAD /v1/artifacts/:hash` は deploy bearer と read-only artifact-fetch
bearer のいずれかを受け付ける。

### Runtime-agent apply {#runtime-agent-apply}

lifecycle dispatcher は `spec.artifact.kind` を connector の
`acceptedArtifactKinds` と照合する。

---

artifact routes は build / source transform を実行しない。 build は AppSpec の
`component.build` と installer lifecycle の責務であり、 artifact routes は
アップロード済み blob の保存・取得・GC だけを扱う。 (= Wave N planned:
`component.build` は削除予定、 build 責務は別 `kind: build` component (=
operator distribution が JSON-LD + plugin で持ち込む) に移管。 詳細
[RFC 0001](../rfc/0001-kernel-kind-agnostic.md)。)

## サイズポリシー {#size-policy}

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

### アップロードが実効上限超過 {#upload-exceeds-effective-cap}

- HTTP / code: `413 resource_exhausted`
- Recovery: `TAKOSUMI_ARTIFACT_MAX_BYTES` を上げる、 より大きい `maxSize` を
  register する、 artifact を圧縮する、 R2 / S3 / GCS へ storage を移す

### Digest 不一致 {#digest-mismatch}

- HTTP / code: `400 invalid_argument`
- Recovery: 計算済 digest で re-upload するか、 expected digest を修正

### deploy bearer 不足 {#missing-deploy-bearer}

- HTTP / code: `401 unauthenticated` または public token 未設定時は route `404`
- Recovery: `TAKOSUMI_DEPLOY_TOKEN` を設定

## Accepted-Kind ポリシー {#accepted-kind-policy}

`Artifact.kind` は protocol 層では open だが、 各 connector は受け付けるものを
宣言する。 例:

- OCI-backed worker connectors: `oci-image`
- Cloudflare Workers / Deno Deploy: `js-bundle`
- Operator-installed custom connectors: 明示的に宣言した registered or custom
  kind

runtime-agent は connector コードが動く前に mismatch を reject する。Component
kind レベルの validation はより厳しいことがある: `worker` は build output 由来の
`js-bundle` を要求できる。

## 認証ポリシー {#auth-policy}

artifact surface は意図的に write / read credential を分離する。

- `TAKOSUMI_DEPLOY_TOKEN`: artifact upload、 list、 delete、 GC、 read
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN`: runtime-agent host 向けの read-only `GET` /
  `HEAD /v1/artifacts/:hash`

runtime-agent は apply のために upload された bytes を fetch するだけで済む
場合、 read-only token を受け取る。 deploy bearer は不要であるべきだ。

## オペレーター surface {#operator-surface}

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

- [DataAsset Kinds](./kind-catalog.md#artifact-kinds)
- [Connector Contract](./connector-contract.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Environment Variables](./env-vars.md)
- [Audit Events](./audit-events.md)
