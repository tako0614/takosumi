# Rollback SOP

> このページでわかること: production-impacting release の rollback 判断、
> deployment-id ベース rollback、one-click revert、staging rehearsal 証跡。

> **Parent workflow**: Rollback is activated when a deploy rollback is required
> during incident response. See
> [`./incident-response.md`](./incident-response.md) for the activation chain
> (SEV declaration → mitigation priority → rollback). If rollback fails and
> serving state cannot be restored, escalate to
> [`./disaster-recovery.md`](./disaster-recovery.md).

| Field         | Value                          |
| ------------- | ------------------------------ |
| Last reviewed | 2026-05-07                     |
| Owner         | Release owner / on-call owner  |
| Scope         | Takos managed service rollback |

## When to Roll Back

release で以下が発生したら、即座に rollback assessment を開始する:

- authentication / billing-safe account access / Git hosting / deploy / agent
  execution の障害
- cross-tenant data exposure リスク
- 破壊的 migration や data integrity リスク
- mitigation 後も SLO breach が続く
- serving state 不明の production deploy 失敗

forward fix は rollback 不可、または小規模 reviewed fix のほうが明らかに速い
場合のみ許可します。reviewer / risk / fallback path を記録します。

## Fast Path

1. 影響 product root の以降の deploy を freeze する。
2. 現在の deployment id、直前の healthy deployment id、commit SHA、image
   digest、Cloudflare worker version id を特定する。
3. 直前 artifact が retain されており、現行 schema と互換であることを確認する。
4. 該当 owner の rollback path を実行する。
5. Web / API login、Git hosting、deploy status、影響 customer workflow
   を検証する。
6. customer impact がある場合は incident response runbook に従って mitigation
   状況を告知する。
7. operator、timestamp、コマンド、before / after deployment id、smoke 結果、
   follow-up owner を evidence として記録する。

## Rollback Paths

| Surface                                       | Primary rollback                                                                                                                                                                                                                                                                                                       | Evidence                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Takosumi platform worker on Cloudflare        | redeploy previous build via `platform-worker-deploy.md` / Cloudflare worker version rollback                                                                                                                                                                                                                           | Cloudflare version id, route, smoke URL                                                          |
| Installation rollback (Installable App Model) | `takosumi rollback inst_<id> dep_<id>` または `POST /v1/installations/:id/rollback` で retained Deployment へ current pointer を戻す。通常 rollback 中も public `status` は `ready` のまま operation metadata / `rolling-back` event で進行を表す。failed repair は `failed -> installing -> ready\|failed` の別フロー | installationId, previous source identity, previous deployment id, InstallationEvent (`rollback`) |
| GitHub source release                         | one-click revert PR or revert commit                                                                                                                                                                                                                                                                                   | revert PR URL, commit SHA                                                                        |
| DB migration                                  | expand/backfill rollback note or restore plan from migration safety doc                                                                                                                                                                                                                                                | migration id, backup / forward-repair plan                                                       |

rollback コマンドは明示的な deployment id / version id / image digest / tag /
commit SHA を target にすること。`latest` のような mutable tag
に依存しないこと。

## One-click Revert

code-only な regression の場合:

1. hosting provider の revert ボタン、または `git revert <sha>` を使う。
2. revert PR は最小にし、incident / release record をリンクする。
3. 影響 product root の required check を実行する。
4. active SEV による emergency production forward-fix が必要な場合を除き、 まず
   staging に promote する。
5. root-cause 分析用に元 release branch は保持する。

## Verification

以下が満たされるまで rollback は完了しない:

- production route が想定した直前 version を serve する
- health check と request log が recovery を示す
- release owner が影響 user workflow の recovery を確認する
- rollback metric と deployment audit event が存在する
- customer communication の方針が決まっている

verification が失敗し serving state を復元できない場合 (rollback target 自体が
unhealthy、直前 artifact が利用不能、recovery 時間が RTO 超過) は、
[`./disaster-recovery.md`](./disaster-recovery.md) にエスカレートし、
[`./incident-response.md`](./incident-response.md) に従い incident commander に
DR 宣言の評価を依頼します。

## Staging Rehearsal

Public managed Takos launch readiness (ROADMAP.md Managed Takos Offering gap
audit) は、staging rollback rehearsal を 1 回要求します。evidence
には以下を含めます:

- staging release candidate の commit SHA
- 直前の healthy deployment id
- rollback コマンドまたは UI 操作
- rollback 後の smoke 結果
- 判断から recovery までの経過時間
- automation / documentation の gap に対する follow-up 項目
