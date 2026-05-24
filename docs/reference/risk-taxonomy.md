# Risk タクソノミ {#risk-taxonomy}

> このページでわかること: plan / apply pipeline が発火しうる Risk の closed enum
> 18 active 値を stable id ベースで定義する。

各 Risk は plan 出力上の判定点として働き、 operator が allow / deny /
require-approval を判断する材料になる。 新 Risk kind の追加には `CONVENTIONS.md`
§6 RFC が必要。 entry 番号は historical で安定 ID として扱う (= 番号は renumber
せず、 過去 audit / docs cross-ref の連続性を保つ。 entry 15 は欠番)。

## Risk と Error {#risk-vs-error}

両者は別 concept。

- **Risk**: plan 出力時の判定点。 `allow` / `deny` / `require-approval` の 3
  値で resolve され、 approve 可能。 binding が approval record に乗る。
- **Error**: operation result の失敗理由 (DomainErrorCode /
  LifecycleErrorBody)。 approve 対象ではなく、 再 plan / 再 apply で解消する。

Risk が stage 進行中に再評価されて approval が崩れる経路は
[Approval Invalidation Triggers](./approval-invalidation.md) に従う。

## Closed enum (18 active values, stable ids 1-19) {#closed-enum-18-values}

各 Risk は以下の attributes を持つ:

- **stable id**: enum の wire 値。永続化される。
- **発火 stage**: `prepare` / `pre-commit` / `commit` / `post-commit` /
  `observe` / `finalize` のうち、実際に Risk が emit されうる stage。
- **severity**: `warning` / `error`。`error` severity は approval 無しでは 必ず
  `deny` になる。
- **invalidation trigger**: 当該 Risk に関連する approval invalidation trigger
  番号 (1-6、詳細は [approval-invalidation](./approval-invalidation.md))。
- **fix kind**: `safeFix` / `requiresPolicyReview` / `operatorFix` のうち
  生成可能なもの。

### 1. `secret-projection`

- **意味**: managed secret projection の plan / input で raw 値が AppSpec /
  output / log 上に露出する可能性を示す。DesiredSnapshot には secret reference
  または redacted sentinel だけを保存し、raw secret value は保存しない。
  projection を approve しない限り secret は materialize されない。
- **発火 stage**: `prepare`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `requiresPolicyReview`

### 2. `external-export`

operator-internal share model や future extension で、外部 Space へ export
する操作を扱う場合の候補 Risk です。current public AppSpec v1 は external export
を直接宣言しません。

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

- **意味**: 新 outbound network egress を許可する component が含まれる。
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

- **意味**: 消費する operator-owned ExportDeclaration の freshness が policy
  許容 window を超えており、 plan は最新化されない export snapshot に bind さ
  れている。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 4
- **fix kind**: `operatorFix`

### 8. `revoked-export`

- **意味**: 消費する operator-owned ExportDeclaration が revoke 済 (= generated
  material は残るが新規 link projection は許可されない状態)。
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

operator-internal share model や future extension で cross-Space link
を扱う場合の候補 Risk です。current public AppSpec v1 は cross-Space link
を宣言できず、kernel は reject します。

- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 4, 6
- **fix kind**: `requiresPolicyReview`

### 11. `shadowed-namespace`

- **意味**: reserved / future sharing model で、同じ namespace path が複数
  source から見える可能性を示す。current public v1 は Space-visible operator
  export の exact match だけを解決し、duplicate / shadow は policy choice
  ではなく invalid resolution として fail-closed する。
- **発火 stage**: `prepare`
- **severity**: `warning`
- **invalidation trigger**: 4, 5
- **fix kind**: `requiresPolicyReview`

### 12. `implementation-unverified`

- **意味**: 選択された Implementation が operator の visible implementation
  config に存在し ない状態で binding されようとしている。
- **発火 stage**: `prepare`
- **severity**: `error`
- **invalidation trigger**: 3, 5
- **fix kind**: `operatorFix`

### 13. `actual-effects-overflow`

- **意味**: connector が `commit` / `post-commit` で報告した actual-effects が
  `predictedActualEffectsDigest` を超過した。
- **発火 stage**: `commit`, `post-commit`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `operatorFix`

### 14. `rollback-revalidation-required`

- **意味**: rollback / compensate recovery が走った際、target Deployment の
  recorded evidence に沿った復元に改めて approval が要る。
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

- **意味**: AppSpec または projection input に raw secret literal が混入している
  疑い。kernel は値を DesiredSnapshot に保存せず、保存前の validation /
  projection planning で Risk として可視化する。
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

- **意味**: 当該 plan が approval を得ていない DataAsset transform を実行しよう
  としている。
- **発火 stage**: `pre-commit`
- **severity**: `error`
- **invalidation trigger**: 2
- **fix kind**: `requiresPolicyReview`

## Severity と approval gate の関係 {#severity-と-approval-gate-の関係}

- `error` severity の Risk は approval grant が無いと plan が `deny` される。
  approve すれば `allow` に転じる。
- `warning` severity の Risk は default policy 次第で `allow` /
  `require-approval` のどちらにもなる。policy pack で fine-tune する。
- 1 つの plan に複数 Risk が同時に発火することは普通にあり、approval record
  はそれらをまとめて `approvedEffects` set として保持する。

## Fix kind の意味 {#fix-kind-の意味}

- `safeFix`: kernel / CLI が automatically 提示できる修正案がある (例: literal
  を managed secret に置き換える、traffic 配分を rollback 互換に直す)。
- `requiresPolicyReview`: policy pack / approval flow を経由しないと進めない。
  operator 単独では解消しない。
- `operatorFix`: operator の手動操作 (export refresh / implementation config
  update / collision resolution / RevokeDebt clearance) が要る。

## RFC 要件 {#rfc-要件}

新 Risk kind の追加は plan / approval / WAL のすべてに影響するため、
`CONVENTIONS.md` §6 の RFC を要する。 stable id は付与後 rename しない。 削除も
同様に RFC を経由し、 stable id は欠番として保持する (= 過去 audit の再評価で ID
が解決可能であることを保証する)。

## 関連アーキテクチャ {#related-architecture-notes}

関連 architecture notes:

- `docs/reference/architecture/policy-risk-approval-error-model.md` — Risk vs
  Error の境界、 stable id 1-19 (15 reserved) の選定理由、severity / fix kind
  の設計議論
- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal`
  — `actual-effects-overflow` / `rollback-revalidation-required` の WAL 上での
  位置付け
- `docs/reference/drift-detection.md` — `revoke-debt-created` と observe /
  finalize stage の連動

## 関連ページ

- [Approval Invalidation Triggers](./approval-invalidation.md)
- [WAL Stages](./wal-stages.md)
- [RevokeDebt Model](./revoke-debt.md)
