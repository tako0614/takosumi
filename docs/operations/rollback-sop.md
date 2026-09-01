# Rollback SOP

> このページでわかること: production-impacting release の rollback 判断、
> worker version / StateVersion target ベース rollback、one-click revert、staging rehearsal 証跡。

> **Parent workflow**: Rollback is activated when a deploy rollback is required
> during incident response. See
> [`./incident-response.md`](./incident-response.md) for the activation chain
> (SEV declaration → mitigation priority → rollback). If rollback fails and
> serving state cannot be restored, escalate to
> [`./disaster-recovery.md`](./disaster-recovery.md).

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Last reviewed | 2026-07-22                                 |
| Owner         | Release owner / on-call owner              |
| Scope         | Takosumi platform and Capsule rollback SOP |

## When to Roll Back

release で以下が発生したら、即座に rollback assessment を開始する:

- authentication / account access / quota-safe source sync / plan/apply /
  runner execution の障害
- cross-tenant data exposure リスク
- 破壊的 migration や data integrity リスク
- mitigation 後も SLO breach が続く
- serving state 不明の production deploy 失敗

forward fix は rollback 不可、または小規模 reviewed fix のほうが明らかに速い
場合のみ許可します。reviewer / risk / fallback path を記録します。

## Fast Path

1. 影響する Takosumi platform worker deploy、Source release、または Capsule apply を freeze します。
2. 現在の platform release/version id、直前の healthy version、commit SHA、変更不可の
   artifact digest を特定します。
3. 直前 artifact が retain されており、現行 schema と互換であることを確認します。
4. 該当 owner の rollback path を実行します。
5. Web / API login、Source git read、Run status、影響 user/tenant workflow
   を検証します。
6. user/tenant impact がある場合は incident response runbook に従って mitigation
   状況を告知します。
7. operator、timestamp、コマンド、before / after platform version id、smoke 結果、
   follow-up owner を evidence として記録します。

## Rollback Paths

| Surface                      | Primary rollback                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Takosumi platform deployment | operator-selected deployment adapter で直前の変更不可な build/version を redeploy                                                                                                                                                                                                                                 | host version id, route, smoke result                                                                              |
| Capsule state rollback       | create a rollback plan for a retained StateVersion / source identity / Output evidence target, review the generated plan, then use the normal approval/apply flow. Rollback must create a new Run plus StateVersion / Output / AuditEvent evidence; Takosumi exposes no parallel rollback ledger or legacy endpoint. | capsuleId, target StateVersion id, rollback plan run id, apply run id, resulting StateVersion / Output generation |
| Source release               | one-click revert PR or revert commit in the source repository, followed by a normal Takosumi source sync / compatibility check / plan / apply flow                                                                                                                                                                   | revert PR URL, commit SHA, source snapshot id                                                                     |
| DB / ledger migration        | use an expand/backfill forward repair by default; use restore only when the migration safety note explicitly declares that restore is safer than forward repair                                                                                                                                                      | migration id, backup id, forward-repair or restore plan                                                           |

rollback コマンドは明示的な platform version id / artifact digest / tag /
commit SHA を target にすること。`latest` のような mutable tag
に依存しないこと。

## One-click Revert

code-only な regression の場合:

1. selected deployment adapter の変更不可の version rollback、または `git revert <sha>` を使います。
2. revert PR は最小にし、incident / release record をリンクします。
3. 影響範囲に応じて Takosumi platform worker、Source repo、または Capsule plan/apply の required check を実行します。
4. active SEV による emergency production forward-fix が必要な場合を除き、 まず
   staging に promote します。
5. root-cause 分析用に元 release branch は保持します。

## Verification

以下が満たされるまで rollback は完了しない:

- production route が想定した直前 version を serve する
- health check と request log が recovery を示す
- release owner が影響 user workflow の recovery を確認する
- rollback Run、StateVersion / Output evidence、AuditEvent が存在する
- affected-user communication の方針が決まっている

verification が失敗し serving state を復元できない場合 (rollback target 自体が
unhealthy、直前 artifact が利用不能、recovery 時間が RTO 超過) は、
[`./disaster-recovery.md`](./disaster-recovery.md) にエスカレートし、
[`./incident-response.md`](./incident-response.md) に従い incident commander に
DR 宣言の評価を依頼します。

## Staging Rehearsal

Operator platform readiness は、staging rollback rehearsal を 1 回要求します。evidence
には以下を含めます:

- staging release candidate の commit SHA
- 直前の healthy host version id
- rollback コマンドまたは UI 操作
- rollback 後の smoke 結果
- 判断から recovery までの経過時間
- automation / documentation の gap に対する follow-up 項目

### Runner Profile cutover / rollback drill

Runner Profile migration は install config を直接書き換えず、current Run ledger
だけで rehearsal します。staging または fresh replica に scratch Capsule、既知の
retained StateVersion、source profile、provider-neutral canary profile を用意します。
OSS は特定 host の credential、deployment adapter、evidence store を所有しないため、
この drill 専用 collector は同梱しません。存在しない package script を release
procedure にしてはいけません。operator は選択した control API / CLI と deployment
adapter で以下を実行し、手順と readback を host-owned runbook に固定します。

1. 対象が production ではないこと、scratch Capsule の owner、source commit、
   source/target RunnerProfile、known-good StateVersion を readback します。
2. target profile を指定した通常の plan を作成し、source identity、profile、
   StateVersion lineage、公開 Output digest を review してから通常の approval/apply
   flow を実行します。
3. terminal success と新しい Run / StateVersion / Output / AuditEvent を readback
   し、scratch readiness endpoint を検証します。
4. known-good StateVersion と source profile を target に rollback plan を作成し、
   同じ review / approval / apply flow を実行します。parallel rollback ledger や
   legacy endpoint は使いません。
5. rollback 後の ownership、generation、apply Run provenance、公開 Output digest、
   readiness、開始から recovery までの経過時間を再読します。
6. command/API revision、変更不可の ids/digests、reviewer、結果を repository 外の
   operator evidence store に保存します。

production target、同一 source/target profile、plan の source/profile 不一致、
StateVersion/Output lineage 不一致、Output drift、非成功 Run、readiness failure、
または incomplete readback はすべて安全側に停止し、成功 evidence を作りません。
token、raw Output、raw log、provider/account identifier は evidence へ転記しません。

この drill が直接証明するのは Run / StateVersion / Output / readiness の core
rollback だけです。OIDC client、domain 設定、data namespace、InterfaceBinding の
continuity は別の readback / conformance evidence が必要です。必要な continuity /
domain-preservation / preserve evidence が揃うまで該当 host readiness は `blocked`
のままです。fresh replica の結果は staging evidence へ自動 merge せず、変更不可の
standalone evidence として保存します。

## Extension Readiness

hosted/commercial deployment 固有の GA drill、evidence batch、private evidence
layout は host-owned readiness contribution と runbook が所有します。OSS baseline
は `release-promotion` / `rollback` / `release-note` の汎用 evidence shape だけを
検証し、特定 host の command、provider version id、private repository path を
要求しません。
