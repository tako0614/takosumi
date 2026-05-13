# DataAsset Model

> このページでわかること: DataAsset のモデル定義とライフサイクル。

DataAsset は Object や Operation が使うコンテンツ・入力を表す。DataAsset の可
視性は Space scope であり、operator の artifact policy が明示的に共有を許可し
た場合のみ scope を超える。

## v1 の対象範囲

Public v1 がサポートするもの:

```text
prebuilt artifact reference
content-addressed artifact upload
operator-registered artifact kind discovery
```

Public v1 では任意のユーザーシェル build や、operator API / 承認フロー /
テストが整っていない状態での runtime 自動マッチングはサポートしない。

## DataAsset kind

```yaml
DataAsset:
  spaceId: space:acme-prod
  id: asset:...
  kind: string # bundled: oci-image | js-bundle | lambda-zip | static-bundle | wasm
  digest: sha256:...
  uri: optional
  source: optional
```

`kind` はプロトコル層では open で、`registerArtifactKind` /
`GET /v1/artifacts/kinds` から discover できる。同梱の registry は
`oci-image`、`js-bundle`、`lambda-zip`、`static-bundle`、`wasm` で始まる。

## Connector contract

connector は、DataAsset の bytes を implementation の手の届く範囲に持ち込む、
operator がインストールする binding である。connector は public manifest では
ユーザー命名されない。resolution 中に選ばれた implementation から参照される。

```yaml
Connector:
  id: connector:cloudflare-workers-bundle # connector:<id>, operator-controlled
  acceptedKinds: [js-bundle]
  spaceVisibility: operator-policy-driven # which Spaces may use this connector
  signingExpectations: optional # signature / digest requirements
```

Identity rule:

- connector は `connector:<id>` の形でアドレッシングされる。id は operator が
  管理し、ユーザー manifest からは決して選ばない。
- 各 connector は上記 DataAsset kind enum から `acceptedKinds` ベクトルを宣言
  する。Plan は connector の accepted vector に kind が含まれない Link /
  DataAsset binding を reject しなければならない。
- connector の可視性は operator policy 経由で Space scope である。ある Space で
  見える connector が暗黙に別 Space で見えるわけではない。
  [Operator Boundaries](./operator-boundaries.md) を参照。
- connector は public manifest 経由でインストール・差し替え・revoke されること
  はなく、必ず operator surface から導入される。

## Artifact resolution

ローカルファイルは path で kernel に送らない。operator はまず bytes を upload
し、返ってきた digest を manifest に埋め込む。

```text
takosumi artifact push ./worker.js --kind js-bundle
  -> { hash: sha256:..., kind: js-bundle }

resources[].spec.artifact.hash
  -> DataAsset digest visible to the selected Space
```

Transform は operator が承認する operation で、将来の operator surface 用に予
約されている。

```text
source archive -> js-bundle
source archive -> static-bundle
```

Transform operation はポリシーで明示承認されていない限り、runtime secret を受
け取ってはいけない。

### Transform approval enforcement

Transform 承認は
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
の `pre-commit` ステージで強制される。pre-commit verification ステップは
transform を承認した approval を再検証する。
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
の approval invalidation trigger のいずれかが発火した場合、外部 transform 呼び
出しが始まる前に operation は fail-closed で失敗する。

transform が有効な承認なしに `pre-commit` に到達したときに surface される Risk
は `transform-unapproved` である。

## Accepted asset 検証

Plan は関連するすべての layer を検証しなければならない。

```text
ObjectTarget accepted data asset kinds
selected implementation accepted data asset kinds
connector accepted data asset kinds
artifact policy limits
```

## Space 可視性

DataAsset は global に保存されうるが、default で global に可視ではない。
`ResolutionSnapshot` は Space に可視な DataAsset reference を記録する。Space
を跨ぐ artifact 再利用は operator の artifact policy を必要とし、resolution に
記録されなければならない。
