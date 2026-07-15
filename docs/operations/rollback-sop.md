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
| Last reviewed | 2026-07-15                                 |
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

1. 影響する Takosumi platform worker deploy、Source release、または Capsule apply を freeze する。
2. 現在の platform release/version id、直前の healthy version、commit SHA、immutable
   artifact digest を特定する。
3. 直前 artifact が retain されており、現行 schema と互換であることを確認する。
4. 該当 owner の rollback path を実行する。
5. Web / API login、Source git read、Run status、影響 user/tenant workflow
   を検証する。
6. user/tenant impact がある場合は incident response runbook に従って mitigation
   状況を告知する。
7. operator、timestamp、コマンド、before / after platform version id、smoke 結果、
   follow-up owner を evidence として記録する。

## Rollback Paths

| Surface                      | Primary rollback                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Takosumi platform deployment | operator-selected deployment adapter で previous immutable build/version を redeploy                                                                                                                                                                                                                                 | host version id, route, smoke result                                                                              |
| Capsule state rollback       | create a rollback plan for a retained StateVersion / source identity / Output evidence target, review the generated plan, then use the normal approval/apply flow. Rollback must create a new Run plus StateVersion / Output / AuditEvent evidence; Takosumi exposes no parallel rollback ledger or legacy endpoint. | capsuleId, target StateVersion id, rollback plan run id, apply run id, resulting StateVersion / Output generation |
| Source release               | one-click revert PR or revert commit in the source repository, followed by a normal Takosumi source sync / compatibility check / plan / apply flow                                                                                                                                                                   | revert PR URL, commit SHA, source snapshot id                                                                     |
| DB / ledger migration        | use an expand/backfill forward repair by default; use restore only when the migration safety note explicitly declares that restore is safer than forward repair                                                                                                                                                      | migration id, backup id, forward-repair or restore plan                                                           |

rollback コマンドは明示的な platform version id / artifact digest / tag /
commit SHA を target にすること。`latest` のような mutable tag
に依存しないこと。

## One-click Revert

code-only な regression の場合:

1. selected deployment adapter の immutable-version rollback、または `git revert <sha>` を使う。
2. revert PR は最小にし、incident / release record をリンクする。
3. 影響範囲に応じて Takosumi platform worker、Source repo、または Capsule plan/apply の required check を実行する。
4. active SEV による emergency production forward-fix が必要な場合を除き、 まず
   staging に promote する。
5. root-cause 分析用に元 release branch は保持する。

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

## Extension Readiness

hosted/commercial deployment 固有の GA drill、evidence batch、private evidence
layout は host-owned readiness contribution と runbook が所有します。OSS baseline
は `release-promotion` / `rollback` / `release-note` の汎用 evidence shape だけを
検証し、特定 host の command、provider version id、private repository path を
要求しません。
