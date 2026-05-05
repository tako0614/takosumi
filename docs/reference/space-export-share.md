# SpaceExportShare

> Stability: stable Audience: operator, kernel-implementer, integrator See also:
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [RevokeDebt Model](/reference/revoke-debt),
> [Risk Taxonomy](/reference/risk-taxonomy),
> [Access Modes](/reference/access-modes),
> [Audit Events](/reference/audit-events), [CLI](/reference/cli),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums)

SpaceExportShare は Takosumi v1 における **cross-Space link の唯一の
許可された経路**です。default では Space 境界を越える link projection は denied
で、SpaceExportShare が明示的に enroll されたパスのみ許可されます。 本 reference
では share record schema、closed lifecycle、TTL refresh policy、 stale / revoked
時の cleanup、RevokeDebt ownership、operator surface を 固定します。

## SpaceExportShare record

```yaml
SpaceExportShare:
  id: share:01HZ...
  fromSpaceId: space:platform # exporting Space
  toSpaceId: space:acme-prod # importing Space
  exportPath: takos.oauth.token # exporting 側 export address
  exportSnapshotId: export-snapshot:... # share 時点の export snapshot pin
  allowedAccess: # importing 側に許可する access mode 集合
    - read
    - invoke-only
  expiresAt: optional # TTL (任意)
  refreshPolicy: {} # operator-controlled refresh window 設定
  lifecycleState: <enum: 5 値> # 後述
    policyDecisionRefs: [] # 関連 policy decision の参照
```

`exportSnapshotId` は share 確定時の export snapshot を fix し、後で freshness
評価する起点になる。`allowedAccess` の値は
[Access Modes](/reference/access-modes) の closed enum から選ぶ。

`refreshPolicy` は operator-controlled で、kernel が default 値を持たない。
share ごとに refresh window / TTL / threshold を operator が設定する。

## Lifecycle state (5 値 closed)

```text
draft | active | refresh-required | stale | revoked
```

新 state 追加は `CONVENTIONS.md` §6 RFC を要する。

| State              | 意味                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `draft`            | operator が作成中。consumer (importing Space) には可視化されない。resolution 不可。 |
| `active`           | 使用可能。importing Space からの resolution が成功する。                            |
| `refresh-required` | TTL approach で warning。resolution は依然成功するが Risk が emit される。          |
| `stale`            | TTL expired。resolution は `stale-export` Risk で fail-closed。                     |
| `revoked`          | operator が remove した。新 resolution は denied、cleanup queue が走る。            |

terminal は `revoked` のみ。`stale` から `active` への復帰は refresh が
成功した場合に起こり得る。

### Lifecycle transition diagram

```
+-------+    activate    +--------+   approach TTL   +-------------------+
| draft | -------------> | active | ---------------> | refresh-required  |
+-------+                +--------+                  +-------------------+
                           ^   ^                        |          |
                           |   | refresh ok             |          |
                           |   +------------------------+          |
                           |                                       |
                           |                                       v
                           |             refresh fail / TTL expired
                           |                                       |
                           |                                       v
                           |                                  +--------+
                           |                                  | stale  |
                           |                                  +--------+
                           |                                       |
                           | operator revoke                       | operator revoke
                           v                                       v
                      +---------+                              +---------+
                      | revoked | <----------------------------+ revoked |
                      +---------+      (terminal)              +---------+
```

operator は任意の non-terminal state から `revoked` へ進めることができる。

## TTL refresh policy

`refreshPolicy` で以下を指定する。

- **refresh window**: TTL のうち、approaching と判定する threshold。例えば TTL
  30 日で window が 7 日なら、残り 7 日に到達した瞬間に
  `active → refresh-required` に遷移する。
- **refresh attempt 規則**: refresh-required 中の自動 refresh 試行 cadence と
  max attempts。
- **failure handling**: refresh attempt がすべて失敗したときに `stale` に
  落とすか、`refresh-required` のまま hold して operator 介入を待つか。

successful refresh は `refresh-required → active` に戻し、`exportSnapshotId`
を新 snapshot に更新する。失敗が確定したら `stale` に進む。

## Cross-space link denial が default

cross-Space link projection は default で denied。

- importing Space の link declaration が exporting Space の export を
  参照しても、対応する SpaceExportShare が `active` (または `refresh-required`)
  でなければ resolution は失敗する。
- SpaceExportShare 経由で許される access mode は `allowedAccess` 集合に
  限られる。link 側がそれ以外の mode を要求すれば resolution は失敗する。
- `cross-space-link` Risk が link 側で発火し、approval flow に乗る
  ([Risk Taxonomy](/reference/risk-taxonomy) §10)。

## Stale / revoked 時の cleanup

share の lifecycle が `stale` または `revoked` に進んだとき、importing Space
側で当該 share に紐づいて materialize された generated material は cleanup
対象になる。

- cleanup は importing Space owner の責務として走る。
- cleanup が **失敗** した場合、RevokeDebt が
  `reason:
  cross-space-share-expired` で queue される
  ([RevokeDebt Model](/reference/revoke-debt))。
- cleanup 成功時は audit event `share-stale` / `share-revoked` のあとに 通常の
  lifecycle に戻る。

`refresh-required` 中は cleanup を起動しない。share が `active` に復帰
する余地が残るためで、warning Risk のみ surface する。

## RevokeDebt ownership

SpaceExportShare 経由で生まれる RevokeDebt の ownership は、
[RevokeDebt Model](/reference/revoke-debt) の Multi-Space ownership 規則
に従う。

- **importing Space が owner**: share 経由で materialize された material
  に対する RevokeDebt は、importing Space を `ownerSpaceId` とする。 status の
  transition は importing Space 側でしか起こせない。
- **exporting Space は read-only mirror**: exporting Space からは RevokeDebt
  status を mutate できない。share の存在と debt の存在を 可視化するだけ。
- `originatingSpaceId` は exporting Space を保持し、audit / drift 連動の
  参照点として残る。

## Approval invalidation interaction

share の lifecycle 遷移は approval invalidation の **external freshness change**
trigger を引く
([Approval Invalidation Triggers](/reference/approval-invalidation) §4)。

- `active → refresh-required`: 該当 export を消費する binding の approval
  を再評価する。warning だが invalidation を即時には起こさず、binding
  内容が変わらなければ approval を保持する。
- `active → stale` または `* → revoked`: 該当 binding 全てを `invalidated`
  に落とす。

share governance (例えば `allowedAccess` の縮小、`exportPath` 変更) の 編集は
**Space-context change** trigger 6 を引く。

## Operator surface

operator が share を CRUD する経路は CLI と内部 API。

- **create / draft**: operator が exporting Space に新 share を draft
  状態で作る。`fromSpaceId` / `toSpaceId` / `exportPath` / `allowedAccess` /
  `refreshPolicy` を指定する。audit event `share-created`。
- **activate**: draft の share を active に昇格させる。importing Space の owner
  同意が必要 (governance policy で fix)。audit event `share-activated`。
- **refresh**: 自動 refresh の他、operator が手動 refresh を起動できる。 audit
  event `share-refreshed`。
- **revoke**: operator が share を即時 revoke する。`revoked` 確定後、 cleanup
  queue が走る。audit event `share-revoked`。
- **inspect**: operator tooling で state / refreshPolicy / 関連 RevokeDebt 件数
  を表示する。current public `takosumi` CLI には share subcommand はない。

## Audit events

share lifecycle に関連する audit event
([Audit Events](/reference/audit-events)):

- `share-created` — draft 作成時。
- `share-activated` — `draft → active` 遷移時。
- `share-refreshed` — successful refresh 時。
- `share-stale` — `* → stale` 遷移時。
- `share-revoked` — `* → revoked` 遷移時。

各 event payload は `share.id` / `fromSpaceId` / `toSpaceId` / `lifecycleState`
旧新 / `exportSnapshotId` を保持する。

## Invariants

- cross-Space link projection は SpaceExportShare 経由でのみ許可される。
- lifecycle state は 5 値 closed。terminal は `revoked` のみ。
- importing Space が RevokeDebt の owner、exporting Space は read-only mirror。
- `refreshPolicy` は operator-controlled。kernel default なし。
- share の lifecycle 遷移は approval invalidation trigger 4 / 6 を引く。

## Related architecture notes

関連 architecture notes:��

- `docs/reference/architecture/space-model.md` — Space 境界の denial-by-default
  rationale と SpaceExportShare 設計議論
- `docs/reference/architecture/namespace-export-model.md` — exportPath /
  exportSnapshot の semantics と share の関係
- `docs/reference/architecture/observation-drift-revokedebt-model.md` —
  cross-space-share-expired RevokeDebt の生成経路と aging window 議論
