# Approval Invalidation Triggers

> Stability: stable
> Audience: kernel-implementer, operator
> See also: [WAL Stages](/reference/wal-stages), [Risk Taxonomy](/reference/risk-taxonomy), [Lifecycle Protocol](/reference/lifecycle)

Takosumi v1 で approval が `approved` 状態から `invalidated` に落ちる
trigger を 6 値の closed enum で定義し、各 trigger の発火条件 / 検出 timing /
propagation rule / approver UX state を整理する reference です。

## Trigger 6 値

新 trigger 追加は `CONVENTIONS.md` §6 RFC を要する。

1. **digest change** — DesiredSnapshot digest または OperationPlan digest の
   変更。
2. **effect-detail change** — `approvedEffects` / `effectDetailsDigest` /
   grant access / network egress shape の変更。
3. **implementation change** — 選択された Implementation (provider plugin の
   particular binding) の変更。
4. **external freshness change** — ExportDeclaration / SpaceExportShare の
   freshness state 遷移。
5. **catalog release change** — Space に adopted な CatalogRelease の変更。
6. **Space-context change** — Space membership / policy pack /
   SpaceExportShare governance の変更。

### 1. digest change

- **発火条件**: prepare stage 中に再計算した `desiredSnapshotDigest` または
  `operationPlanDigest` が、approval record にバインドされた digest と一致しない。
- **検出 timing**: `prepare` stage の WAL append 直前。kernel が approval
  binding を最後に validate する点。
- **再評価範囲**: approval は即時 `invalidated`。他の binding (effect /
  implementation / freshness / context) を再評価せず短絡する (短絡 invalidate)。

### 2. effect-detail change

- **発火条件**: prepare で resolve された `approvedEffects` /
  `effectDetailsDigest` / 個別 grant access mode / network egress allow set が
  approval record の binding と一致しない。
- **検出 timing**: `prepare` stage と `pre-commit` catalog hook の両方。hook が
  effect を後から expand したケースを catch する。
- **再評価範囲**: approval は即時 `invalidated`。短絡 invalidate (他 binding
  を再評価しない)。

### 3. implementation change

- **発火条件**: provider plugin の selected Implementation (registerProvider で
  binding された particular implementation) が approval bind 時と異なる。
  provider matrix を operator が swap した場合や catalog release 切替で
  起きる。
- **検出 timing**: `prepare` stage の resolve、および `pre-commit` の hook
  起動直前。
- **再評価範囲**: plan を保ったまま `invalidated`。kernel は影響範囲を
  **当該 implementation に依存する binding subset** に絞って propagate する。

### 4. external freshness change

- **発火条件**: ExportDeclaration / SpaceExportShare の freshness state が
  `fresh` から `stale` または `revoked` に遷移。`fresh → refresh-required`
  は warning 相当 (Risk emit のみ) で trigger 4 を **発火させない** —
  approval は `approved` のまま保持される
  ([Observation Retention — Approval invalidation との関係](/reference/observation-retention#approval-invalidation-との関係))。
- **検出 timing**: external freshness は kernel observe loop が継続的に監視
  し、`stale` / `revoked` への遷移を検出した瞬間に対応 approval を再評価
  する。`prepare` stage 起動時の最初の確認も含む。
- **再評価範囲**: 当該 export を消費する binding subset に絞って propagate。
  他の Space に adopted な ExportDeclaration には影響しない。

### 5. catalog release change

- **発火条件**: Space に adopted な CatalogRelease (shape / provider /
  template の release pin) が変更された。
- **検出 timing**: Space adoption 操作の commit 完了直後。kernel は当該 Space
  に紐づく approval を resolve し直す。
- **再評価範囲**: 新 release で binding が同一なら approval を保持、binding が
  変わるなら影響 binding subset を `invalidated`。

### 6. Space-context change

- **発火条件**: Space membership (actor 集合)、policy pack、または
  SpaceExportShare governance (importing/exporting Space relationship) の変更。
- **検出 timing**: 該当 mutation の commit 完了直後。kernel は Space 単位で
  関連 approval を walk する。
- **再評価範囲**: context に依存する binding subset に絞って propagate。actor
  removal は `actor` field が消えた approval だけを invalidate する。

## Propagation 規則

- 1 つの trigger でも発火すれば、対象 approval record 全体は `invalidated`
  状態になる。再 approve には新 OperationPlan / 新 binding での再評価が要る。
- Trigger 1, 2 (digest 系) は **短絡 invalidate**: 他 binding を再評価せず
  即時 `invalidated` 確定。
- Trigger 3-6 は plan を保ったまま発火し、kernel は **影響範囲を minimum
  approval set に絞って propagate** する。Space 全体や全 plan を巻き込まない。
- propagation 中の approval re-validation は WAL stage を進めず、`prepare`
  への巻き戻し経路でのみ stage に作用する (詳細は
  [WAL Stages — Pre/post-commit hook lifecycle](/reference/wal-stages#prepost-commit-hook-lifecycle))。

## Approver UX states

approval の lifecycle 上の状態:

| State          | 意味                                                          | 永続化         |
| -------------- | ------------------------------------------------------------- | -------------- |
| `pending`      | approver の判断待ち                                            | server         |
| `reviewing`    | approver client が「review 中」と soft mark (UX hint)          | client-only    |
| `approved`     | approver が approve、binding 全 valid                          | server         |
| `denied`       | approver が deny                                               | server         |
| `expired`      | `expiresAt` 経過                                              | server         |
| `invalidated`  | trigger 1-6 のいずれかで binding が崩れた                      | server         |
| `consumed`     | apply で正常消費され、対応する OperationPlan が完了した        | server         |

`reviewing` は client UX のためのソフト状態で、kernel は永続化しない。kernel
側 state machine が永続化する terminal state は 6 値で、`pending → approved
| denied | expired | invalidated`、および `approved → consumed` の経路を
扱う。`consumed` は approval が apply pipeline で正常消費された後の終端で、
audit retention のために record を保持するが再 use はできない。`consumed`
approval を再度 apply 起動に提示すると `failed_precondition` で reject
される。`invalidated` が trigger 1-6 由来の取り消し (binding 崩壊) を表す
のに対し、`consumed` は binding が valid のまま正常消費された後の終端で
ある点が異なる。

## Cross-Space approval ownership

SpaceExportShare 経由の approval は、ownership を share governance に従って
扱う:

- **Approver は importing Space の owner**: 自 Space に effect を取り込む側が
  approve 責務を持つ。
- **Exporting Space は通知のみ**: share の存在を可視化し、freshness state を
  更新するが、approval 状態を mutate できない。
- exporting Space で SpaceExportShare governance が変わった場合、importing
  Space 側の approval は trigger 6 (Space-context change) として再評価される。

## Approval record binding fields

approval record は以下 binding field を持ち、trigger 1-6 はそれぞれ対応 field
の change として実装される。

| Field                          | Bound from                                  | 関連 trigger |
| ------------------------------ | ------------------------------------------- | ------------ |
| `operationPlanDigest`          | OperationPlan content digest                | 1            |
| `desiredSnapshotDigest`        | DesiredSnapshot content digest              | 1            |
| `effectDetailsDigest`          | resolved effect detail set                  | 2            |
| `predictedActualEffectsDigest` | prepare 時の predicted actual-effects       | 2            |
| `approvedEffects`              | risk-by-risk approval grant set             | 2            |
| `actor`                        | approve した actor identity                 | 6            |
| `policyVersion`                | binding 時の policy pack version            | 5, 6         |
| `expiresAt`                    | approval expiry deadline                    | (state expired) |

これらの field は approval grant 時に固定され、勝手に書き換わらない。binding
が崩れたら approval は `invalidated` に落ちる、という invariant が trigger
6 値の根拠になる。

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/policy-risk-approval-error-model.md` — approval invalidation
  trigger の taxonomy と短絡 / propagation 設計の議論
- `docs/design/operation-plan-write-ahead-journal-model.md` — approval
  binding が WAL stage と接続する境界の rationale
- `docs/design/space-model.md` — Cross-Space approval ownership の設計議論
