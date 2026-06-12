# Rollback SOP

> このページでわかること: production-impacting release の rollback 判断、
> deployment-id ベース rollback、one-click revert、staging rehearsal 証跡。

> **Parent workflow**: Rollback is activated when a deploy rollback is required
> during incident response. See
> [`./incident-response.md`](./incident-response.md) for the activation chain
> (SEV declaration → mitigation priority → rollback). If rollback fails and
> serving state cannot be restored, escalate to
> [`./disaster-recovery.md`](./disaster-recovery.md).

| Field         | Value                                           |
| ------------- | ----------------------------------------------- |
| Last reviewed | 2026-06-07                                      |
| Owner         | Release owner / on-call owner                   |
| Scope         | Takosumi platform and Installation rollback SOP |

## When to Roll Back

release で以下が発生したら、即座に rollback assessment を開始する:

- authentication / billing-safe account access / source sync / plan/apply /
  runner execution の障害
- cross-tenant data exposure リスク
- 破壊的 migration や data integrity リスク
- mitigation 後も SLO breach が続く
- serving state 不明の production deploy 失敗

forward fix は rollback 不可、または小規模 reviewed fix のほうが明らかに速い
場合のみ許可します。reviewer / risk / fallback path を記録します。

## Fast Path

1. 影響する Takosumi platform worker deploy、Source release、または Installation apply を freeze する。
2. 現在の deployment id、直前の healthy deployment id、commit SHA、image
   digest、Cloudflare worker version id を特定する。
3. 直前 artifact が retain されており、現行 schema と互換であることを確認する。
4. 該当 owner の rollback path を実行する。
5. Web / API login、Source git read、Run status、影響 customer workflow
   を検証する。
6. customer impact がある場合は incident response runbook に従って mitigation
   状況を告知する。
7. operator、timestamp、コマンド、before / after deployment id、smoke 結果、
   follow-up owner を evidence として記録する。

## Rollback Paths

| Surface                                | Primary rollback                                                                                                                                                                                                                         | Evidence                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Takosumi platform worker on Cloudflare | redeploy previous build via `platform-worker-deploy.md` / Cloudflare worker version rollback                                                                                                                                             | Cloudflare version id, route, smoke URL                                                                    |
| Capsule Installation rollback          | create a rollback plan for a retained `Deployment` with `POST /api/v1/deployments/:deploymentId/rollback-plan`, review the generated plan, then use the normal approval/apply flow. Rollback must create a new Run/Deployment ledger entry. | installationId, target deployment id, rollback plan run id, apply run id, resulting state/output generation |
| Source release                         | one-click revert PR or revert commit in the source repository, followed by a normal Takosumi source sync / compatibility check / plan / apply flow                                                                                      | revert PR URL, commit SHA, source snapshot id                                                              |
| DB / ledger migration                  | use an expand/backfill forward repair by default; use restore only when the migration safety note explicitly declares that restore is safer than forward repair                                                                           | migration id, backup id, forward-repair or restore plan                                                    |

rollback コマンドは明示的な deployment id / version id / image digest / tag /
commit SHA を target にすること。`latest` のような mutable tag
に依存しないこと。

## One-click Revert

code-only な regression の場合:

1. hosting provider の revert ボタン、または `git revert <sha>` を使う。
2. revert PR は最小にし、incident / release record をリンクする。
3. 影響範囲に応じて Takosumi platform worker、Source repo、または Installation plan/apply の required check を実行する。
4. active SEV による emergency production forward-fix が必要な場合を除き、 まず
   staging に promote する。
5. root-cause 分析用に元 release branch は保持する。

## Verification

以下が満たされるまで rollback は完了しない:

- production route が想定した直前 version を serve する
- health check と request log が recovery を示す
- release owner が影響 user workflow の recovery を確認する
- rollback Run、Deployment、Activity / audit event が存在する
- customer communication の方針が決まっている

verification が失敗し serving state を復元できない場合 (rollback target 自体が
unhealthy、直前 artifact が利用不能、recovery 時間が RTO 超過) は、
[`./disaster-recovery.md`](./disaster-recovery.md) にエスカレートし、
[`./incident-response.md`](./incident-response.md) に従い incident commander に
DR 宣言の評価を依頼します。

## Staging Rehearsal

Hosted Takosumi launch readiness は、staging rollback rehearsal を 1 回要求します。evidence
には以下を含めます:

- staging release candidate の commit SHA
- 直前の healthy deployment id
- rollback コマンドまたは UI 操作
- rollback 後の smoke 結果
- 判断から recovery までの経過時間
- automation / documentation の gap に対する follow-up 項目
