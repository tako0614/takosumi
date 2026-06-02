# Reference Approval Invalidation Profile

::: info
内部設計メモ。public contract は [Installer API](./installer-api.md) を参照。
:::

Operator distributions may carry approval prompts, approval records, and account layer policy state outside the Takosumi Installer API.

## Trigger 6 値

この reference profile での新 trigger 追加は `CONVENTIONS.md` §6 RFC を要する。

1. **digest change** — TargetState digest または OperationPlan digest の変更。
2. **effect-detail change** — `approvedEffects` / `effectDetailsDigest` / generated authorization access / network egress shape の変更。
3. **implementation change** —選択された implementation binding / runtime handler binding の変更。
4. **external freshness change** — operator-owned platform service snapshot の freshness
5. **operator implementation config change** — Space に visible な PlatformService inventory / implementation binding / runtime handler visibility の変更。
6. **Space-context change** — Space membership / policy pack の変更。

### 1. digest change

- **発火条件**: prepare stage 中に再計算した `desiredSnapshotDigest` または `operationPlanDigest` が、approval record にバインドされた digest と一致しない。
- **検出 timing**: `prepare` stage の WAL append 直前。reference Takosumi が operator approval profile の binding を最後に validate する点。
- **再評価範囲**: approval は即時 `invalidated`。他の binding (effect / implementation / freshness / context) を再評価せず短絡する (短絡 invalidate)。

### 2. effect-detail change

- **発火条件**: prepare で resolve された `approvedEffects` / `effectDetailsDigest` / 個別 generated authorization access mode / network egress allow set が approval record の binding と一致しない。
- **検出 timing**: `prepare` stage と `pre-commit` verification の両方。 verification が effect を後から expand したケースを catch する。
- **再評価範囲**: approval は即時 `invalidated`。短絡 invalidate (他 binding を再評価しない)。

### 3. implementation change

- **発火条件**: implementation binding / runtime handler binding が approval bind 時と異なる。implementation binding、runtime handler visibility、operator policy を operator が swap した場合に起きる。
- **検出 timing**: `prepare` stage の resolve、および `pre-commit` verification の直前。
- **再評価範囲**: plan を保ったまま `invalidated`。service は影響範囲を **当該 implementation に依存する binding subset** に絞って propagate する。

### 4. external freshness change

- **発火条件**: operator-owned platform service snapshot の freshness state が `fresh` から `stale` または `revoked` に遷移。`fresh → refresh-required` は warning 相当 (Risk emit のみ) で trigger 4 を **発火させない** — approval は `approved` のまま保持される ([Observation Retention — Approval invalidation との関係](./observation-retention.md#approval-invalidation-relationship))。
- **検出 timing**: external freshness は service observe loop が継続的に監視し、`stale` / `revoked` への遷移を検出した瞬間に対応 approval を再評価する。`prepare` stage 起動時の最初の確認も含む。
- **再評価範囲**: 当該 platform service path / snapshot を消費する binding subset に絞って propagate。監視しない。

### 5. operator implementation config change

- **発火条件**: Space に visible な PlatformService inventory、implementation binding、runtime-agent handler inventory、または operator policy による visibility が変更された。
- **検出 timing**: operator implementation config / Space visibility 操作の commit 完了直後。Takosumi service / operator approval profile は当該 Space に紐づく approval を resolve し直す。
- **再評価範囲**: 新 implementation config で binding が同一なら approval を保持、binding が変わるなら影響 binding subset を `invalidated`。

### 6. Authorization-context change

- **発火条件**: operator account layer membership version、scoped installer context、policy pack の変更。
- **検出 timing**: 該当 mutation の commit 完了直後。Takosumi service / operator approval profile は operator から渡された authorization-context digest に紐づく approval を walk する。
- **再評価範囲**: context に依存する binding subset に絞って propagate。actor removal は `actor` field が消えた approval だけを invalidate する。

## Propagation 規則

- 1 つの trigger でも発火すれば、対象 approval record 全体は `invalidated` 状態になる。再 approve には新 OperationPlan / 新 binding での再評価が要る。
- Trigger 1, 2 (digest 系) は **短絡 invalidate**: 他 binding を再評価せず即時 `invalidated` 確定。
- Trigger 3-6 は plan を保ったまま発火し、reference Takosumi / operator approval profile は **影響範囲を minimum approval set に絞って propagate** する。Space 全体や全 plan を巻き込まない。
- propagation 中の approval re-validation は WAL stage を進めず、`prepare` への巻き戻し経路でのみ stage に作用する (詳細は [WAL Stages — Pre/post-commit verification lifecycle](./wal-stages.md#prepost-commit-verification-lifecycle))。

## Approver UX states

approval の lifecycle 上の状態:

| State         | 意味                                                    | 永続化      |
| ------------- | ------------------------------------------------------- | ----------- |
| `pending`     | approver の判断待ち                                     | server      |
| `reviewing`   | approver client が「review 中」と soft mark (UX hint)   | client-only |
| `approved`    | approver が approve、binding 全 valid                   | server      |
| `denied`      | approver が deny                                        | server      |
| `expired`     | `expiresAt` 経過                                        | server      |
| `invalidated` | trigger 1-6 のいずれかで binding が崩れた               | server      |
| `consumed`    | apply で正常消費され、対応する OperationPlan が完了した | server      |

`reviewing` は client UX のソフト状態で、Takosumi service / operator approval profile は永続化しない。

reference profile 側 state machine が永続化する server state は `pending | approved | denied | expired | invalidated | consumed` の 6 値です。 terminal subset は `denied | expired | invalidated | consumed` で、`approved` は apply に消費されるまで再検証対象として残ります。

- `consumed`: approval が apply pipeline で正常消費された後の終端。 audit retention のため record は保持するが再 use はできない。再度 apply 起動に提示すると `failed_precondition` で reject される。
- `invalidated`: trigger 1-6 由来の取り消し (binding 崩壊) を表す。 `consumed` は binding が valid のまま正常消費された終端である点が異なる。

## Approval record binding fields

approval record は以下 binding field を持ち、trigger 1-6 はそれぞれ対応 field の change として実装される。

| Field                                 | Bound from                                    | 関連 trigger    |
| ------------------------------------- | --------------------------------------------- | --------------- |
| `operationPlanDigest`                 | OperationPlan content digest                  | 1               |
| `desiredSnapshotDigest`               | TargetState content digest                    | 1               |
| `effectDetailsDigest`                 | resolved effect detail set                    | 2               |
| `expectedEffectsDigest`               | prepare 時の predicted actual-effects         | 2               |
| `approvedEffects`                     | risk-by-risk approved effect set              | 2               |
| `implementationBindingDigest`         | implementation binding / runtime handler binding    | 3               |
| `operatorImplementationConfigVersion` | operator implementation / alias config marker | 5               |
| `actor`                               | approve した actor identity                   | 6               |
| `policyVersion`                       | binding 時の policy pack version              | 5, 6            |
| `expiresAt`                           | approval expiry deadline                      | (state expired) |

これらの field は approval decision 時に固定され、勝手に書き換わらない。binding が崩れたら approval は `invalidated` に落ちる、という invariant が trigger 6 値の根拠になる。

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/approval-model.md` — approval invalidation trigger の taxonomy と短絡 / propagation 設計の議論
- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal` — approval binding が WAL stage と接続する境界の rationale
- `docs/reference/architecture/space-model.md` — Cross-Space approval ownership の設計議論

## 関連ページ

- [WAL Stages](./wal-stages.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Lifecycle Protocol](./lifecycle.md)
