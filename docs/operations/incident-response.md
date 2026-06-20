# Operations: Incident Response Runbook

> このページでわかること: Takosumi operated environments で incident を宣言し、 war
> room を立て、mitigation / customer comms / RCA / postmortem を進める
> 標準手順。

> **Scope**: この runbook は SEV 宣言後の **response フェーズ** を扱います。
> trigger 条件と SEV 定義 (SEV-1 / SEV-2 / SEV-3 の基準、ack target、update
> cadence) は
> [`./oncall.md § SEV Classification`](./oncall.md#sev-classification)
> を参照してください。 paging path と escalation matrix も `oncall.md`
> 側にあります。

この runbook は [On-call and SEV Policy](./oncall.md) の実行手順です。 SEV
判断、paging、escalation は on-call policy を正本とし、このページでは incident
開始後の進め方、記録形式、RCA template、postmortem cadence を固定 します。

## Trigger

Incident response を開始する条件 (SEV definitions は
[`./oncall.md § SEV Classification`](./oncall.md#sev-classification) を参照):

- SEV-1 / SEV-2 が宣言された
- customer data exposure / data loss / secret exposure の疑いがある
- deploy rollback が失敗し、customer impact が継続している
- SLA breach が medium 以上で検知され、誤検知と断定できない
- support 経由の customer report が monitoring と矛盾し、影響範囲が不明

不明な場合は incident として開始します。false positive は postmortem ではなく
alert tuning action として閉じます。

## War Room Setup

Incident commander は 5 分以内に war room を作ります。

Naming:

```text
#inc-YYYYMMDD-short-slug
```

Pinned header:

```text
SEV: SEV-<1|2|3>
State: detecting | acknowledged | mitigating | monitoring | resolved
Start: YYYY-MM-DD HH:mm TZ
Incident commander:
Primary on-call:
Comms owner:
Affected services:
Affected regions:
Known customer impact:
Current mitigation owner:
Next update due:
```

War room の最初の 10 分で決めること:

1. SEV level と scope
2. customer-visible impact の有無
3. writes / deploy / background jobs を止めるか
4. rollback / traffic shift / feature flag / credential disablement の候補
5. customer update の初回時刻

## Lifecycle

| State        | Entry condition                                 | Exit condition                                     |
| ------------ | ----------------------------------------------- | -------------------------------------------------- |
| detecting    | alert or report received                        | incident commander が SEV / scope を確認           |
| acknowledged | operator が実インシデントとして扱う             | mitigation owner が決まり、行動開始                |
| mitigating   | active mitigation in progress                   | recovery signal が出る、または別 mitigation に切替 |
| monitoring   | customer impact は止まったが再発監視中          | 2 observation windows green                        |
| resolved     | impact が解消し、follow-up owner が割り当て済み | postmortem / action tracking へ移行                |

State transition は timeline に残します。Takosumi incident tracking が使える
環境では同じ state を incident record に反映します。

## First 15 Minutes

1. page を ack し、war room を開く。
2. 初期 SEV と影響範囲を宣言する。
3. 影響 service set への非必須 deploy を freeze する。
4. 以下を任命する:
   - incident commander
   - mitigation owner
   - investigation owner
   - communications owner
5. 現在の signal を収集する:
   - HTTP 5xx / latency
   - deploy success / rollback metric
   - runner container health / queue backlog
   - database / queue / object storage の状態
   - Provider Catalog changes、Provider Connection changes、egress
     policy changes、Connection driver deploy
   - 直近の deploy、config / secret rotation
6. 最もリスクの低い mitigation を選び、実行前に judgement を channel に書く。

## Mitigation Priority

reversible なアクションを以下の順で優先する:

1. 影響 path への新規 write / deploy を停止
2. 既知の healthy deployment へ rollback
3. 不調な runtime / region から traffic を逃がす
4. feature flag や integration を無効化する
5. 影響を受けた runner queue / container pool を drain / restart する
6. 漏洩疑いの credential を rotate / revoke する
7. forward fix を適用する

forward fix は SEV-1 では rollback 不可、または小規模 reviewed fix のほうが
明らかに速い場合のみ許可します。ship 前に reviewer と rollback plan
を記録します。

## Customer Communications

SEV-1:

- 15 分以内に initial customer / status update を出す
- monitoring state に入るまで 15 分ごとに update する
- 解決後に final update を出す

SEV-2:

- customer-visible な場合は 30 分以内に initial update を出す
- 30 分ごと、または material な state 変化のたびに update する
- customer に通知済みなら final update を出す

customer update には impact と次回 update 予定時刻を含めます。raw stack trace、
secret 名、provider account id、private channel link、未確定の root cause を
含めてはいけません。

## Timeline Format

material な event はすべて以下の形式で記録します:

```text
HH:mm TZ - actor - event - evidence/link - decision/next action
```

Examples:

```text
10:03 JST - primary - page acknowledged - alert deploy-success-rate-low - SEV-2 declared
10:09 JST - mitigation owner - rollback started - deployment dep_123 -> dep_120 - monitoring apply latency
10:18 JST - comms - status update posted - status page incident inc_456 - next update 10:33
```

## RCA Template

SEV-1 と該当する SEV-2 incident には以下のテンプレートを使う。

```md
# Incident RCA: <title>

## Summary

- SEV:
- Start:
- End:
- Duration:
- Affected services:
- Affected customers / tenants:
- Customer impact:

## Detection

- How was it detected:
- Detection time:
- Ack time:
- Detection gap:

## Timeline

| Time | Actor | Event | Evidence | Decision |
| ---- | ----- | ----- | -------- | -------- |

## Root Cause

What failed:

Why it failed:

Why existing controls did not prevent it:

## Mitigation and Recovery

- Mitigation actions:
- Rollback / forward-fix details:
- Recovery signal:
- Time to recovery:

## Customer Communication

- Initial update time:
- Update cadence:
- Final update:

## Action Items

| Action | Owner | Due | Severity | Verification |
| ------ | ----- | --- | -------- | ------------ |

## Classification Review

- Was SEV correct:
- Should alerts / thresholds change:
- Should runbooks change:
```

## Postmortem Cadence

| Incident                            | Draft due                     | Review due                 | Action review                            |
| ----------------------------------- | ----------------------------- | -------------------------- | ---------------------------------------- |
| SEV-1                               | 2 business days               | 5 business days            | weekly until all critical actions closed |
| SEV-2 with customer impact > 30 min | 5 business days               | 10 business days           | biweekly                                 |
| SEV-2 rollback failure / data risk  | 3 business days               | 7 business days            | weekly                                   |
| SEV-3                               | not required unless recurring | incident commander decides | normal backlog                           |

postmortem review は blameless で、system 変更にフォーカスします。 action item
には単一の owner、due date、verification method を必ず付けます。

## Closure Checklist

- incident state が `resolved`
- 影響 metric が 2 observation window 連続で green
- deploy freeze を解除、または明示的に延長済み
- 必要なら customer final update を送付済み
- RCA owner を任命済み
- action item を起票しリンク済み
- monitoring / alert tuning の gap を記録済み
- runbook の gap を記録済み

SEV-1 は RCA owner と postmortem 日程が決まらないうちは close しないこと。
