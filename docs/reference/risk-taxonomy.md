# Risk Taxonomy

> Stability: stable Audience: kernel-implementer, operator See also:
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [WAL Stages](/reference/wal-stages),
> [RevokeDebt Model](/reference/revoke-debt)

Takosumi v1 で plan / apply pipeline が発火しうる Risk の closed enum (19 値)
を、stable id ベースで定義する reference です。各 Risk は plan 出力上の
判定点として機能し、operator が allow / deny / require-approval を判断する
材料になります。新 Risk kind 追加には `CONVENTIONS.md` §6 RFC が必要です。

## Risk vs Error

両者は別の concept です。混同しないこと:

- **Risk**: plan 出力時の判定点。`allow` / `deny` / `require-approval` の 3 値で
  resolve され、approve 可能。binding が approval record に乗る。
- **Error**: operation result の失敗理由 (DomainErrorCode /
  LifecycleErrorBody)。 approve 対象ではなく、再 plan / 再 apply で解消する。

Risk が stage 進行中に再評価されて approval が崩れる経路は
[Approval Invalidation Triggers](/reference/approval-invalidation) に従う。

## Closed enum (19 値)

各 Risk は以下の attributes を持つ:

- **stable id**: enum の wire 値。永続化される。
- **発火 stage**: `prepare` / `pre-commit` / `commit` / `post-commit` /
  `observe` / `finalize` のうち、実際に Risk が emit されうる stage。
- **severity**: `warning` / `error`。`error` severity は approval 無しでは 必ず
  `deny` になる。
- **invalidation trigger**: 当該 Risk に関連する approval invalidation trigger
  番号 (1-6、詳細は [approval-invalidation](/reference/approval-invalidation))。
- **fix kind**: `safeFix` / `requiresPolicyReview` / `operatorFix` のうち
  生成可能なもの。

### 1. `secret-projection`

- **意味**: managed secret が DesiredSnapshot から projection される際、 raw
  値が manifest / output / log 上に露出する可能性を示す。projection を approve
  しない限り secret は materialize されない。
- **発火 stage**: `prepare`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `requiresPolicyReview`

### 2. `external-export`

- **意味**: 自 Space の object を external participant / 外部 Space に export
  する宣言が含まれる。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 2, 4
- **fix kind**: `requiresPolicyReview`

### 3. `generated-credential`

- **意味**: provider / connector が新 credential を生成して return する。
  approve すると ownership は materialize した Space に固定される。
- **発火 stage**: `pre-commit`
- **severity**: `error`
- **invalidation trigger**: 2, 3
- **fix kind**: `requiresPolicyReview`

### 4. `generated-grant`

- **意味**: 既存 principal に新 grant (IAM role / policy attach 等) を付与
  する。
- **発火 stage**: `pre-commit`
- **severity**: `error`
- **invalidation trigger**: 2, 3
- **fix kind**: `requiresPolicyReview`

### 5. `network-egress`

- **意味**: 新 outbound network egress を許可する shape が含まれる。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 2
- **fix kind**: `requiresPolicyReview`

### 6. `traffic-change`

- **意味**: GroupHead pointer / canary / shadow traffic 配分が変わる。
- **発火 stage**: `pre-commit`
- **severity**: `warning`
- **invalidation trigger**: 2, 3
- **fix kind**: `safeFix`

### 7. `stale-export`

- **意味**: 消費する ExportDeclaration / SpaceExportShare freshness が
  `refresh-required` または `stale` に落ちている。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 4
- **fix kind**: `operatorFix`

### 8. `revoked-export`

- **意味**: 消費する ExportDeclaration / SpaceExportShare が `revoked`。
- **発火 stage**: `prepare`
- **severity**: `error`
- **invalidation trigger**: 4
- **fix kind**: `operatorFix`

### 9. `cross-scope-link`

- **意味**: 同 Space 内で scope (managed / external / operator / generated /
  imported) を越えた link projection が含まれる。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 2
- **fix kind**: `requiresPolicyReview`

### 10. `cross-space-link`

- **意味**: SpaceExportShare 経由で異 Space の object に link を貼る。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 4, 6
- **fix kind**: `requiresPolicyReview`

### 11. `shadowed-namespace`

- **意味**: namespace export 上で同名 export が複数 source から提供され、 どれを
  bind するか policy 解決が要る。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 4, 5
- **fix kind**: `requiresPolicyReview`

### 12. `space-export-share`

- **意味**: 新 SpaceExportShare を draft → active に遷移させる、または既存 share
  を更新する。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 6
- **fix kind**: `requiresPolicyReview`

### 13. `implementation-unverified`

- **意味**: 選択された Implementation が catalog signature 未検証 / publisher
  key 未 enroll の状態で binding されようとしている。
- **発火 stage**: `prepare`
- **severity**: `error`
- **invalidation trigger**: 3, 5
- **fix kind**: `operatorFix`

### 14. `actual-effects-overflow`

- **意味**: connector が `commit` / `post-commit` で報告した actual-effects が
  `predictedActualEffectsDigest` を超過した。
- **発火 stage**: `commit`, `post-commit`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `operatorFix`

### 15. `rollback-revalidation-required`

- **意味**: rollback / compensate recovery が走った際、prior ResolutionSnapshot
  に戻すために改めて approval が要る。
- **発火 stage**: `pre-commit` (compensate path)
- **severity**: `error`
- **invalidation trigger**: 1, 2
- **fix kind**: `requiresPolicyReview`

### 16. `revoke-debt-created`

- **意味**: 当該 entry の進行が新 RevokeDebt を生む見込みがある。
- **発火 stage**: `post-commit`, `observe`, `finalize`, `abort`
- **severity**: `warning`
- **invalidation trigger**: 4
- **fix kind**: `operatorFix`

### 17. `raw-secret-literal`

- **意味**: manifest / DesiredSnapshot 中に raw secret literal が混入している
  疑い。kernel は値を保存しない方針でも、Risk として可視化する。
- **発火 stage**: `prepare`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `safeFix`

### 18. `collision-detected`

- **意味**: 同名 / 同 namespace の object を別 source が同時に作ろうとしている
  か、既に存在する unmanaged object と衝突する。
- **発火 stage**: `pre-commit`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `operatorFix`

### 19. `transform-unapproved`

- **意味**: design-reserved DataAsset transform が未承認のまま実行されようと
  している。
- **発火 stage**: `pre-commit`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `requiresPolicyReview`

## Severity と approval gate の関係

- `error` severity の Risk は approval grant が無いと plan が `deny` される。
  approve すれば `allow` に転じる。
- `warning` severity の Risk は default policy 次第で `allow` /
  `require-approval` のどちらにもなる。policy pack で fine-tune する。
- 1 つの plan に複数 Risk が同時に発火することは普通にあり、approval record
  はそれらをまとめて `approvedEffects` set として保持する。

## Fix kind の意味

- `safeFix`: kernel / CLI が automatically 提示できる修正案がある (例: literal
  を managed secret に置き換える、traffic 配分を rollback 互換に直す)。
- `requiresPolicyReview`: policy pack / approval flow を経由しないと進めない。
  operator 単独では解消しない。
- `operatorFix`: operator の手動操作 (export refresh / catalog signature
  enrollment / collision resolution / RevokeDebt clearance) が要る。

## RFC 要件

新 Risk kind の追加は plan / approval / WAL のすべてに影響するため、
`CONVENTIONS.md` §6 の RFC を要する。stable id は付与後 rename しない。 削除も同
RFC 経路で legacy id の wire 互換期間を確保した上で行う。

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/policy-risk-approval-error-model.md` — Risk vs Error の境界、 19
  値 enum の選定理由、severity / fix kind の設計議論
- `docs/design/operation-plan-write-ahead-journal-model.md` —
  `actual-effects-overflow` / `rollback-revalidation-required` の WAL 上での
  位置付け
- `docs/design/observation-drift-revokedebt-model.md` — `revoke-debt-created` と
  observe / finalize stage の連動
