# Model

Takosumi の data model は **Space 直下の OpenTofu Installation DAG** です。正本は
[`core-spec.md`](../core-spec.md) (§4-§21 が entity、§27 が logical schema)。contract の正本は
`packages/schema/src/*.ts` で、本ページが矛盾した場合は schema と spec が優先します。

```text
Space
  └─ Installation (= 1 OpenTofu root/state)
       Source / SourceSnapshot
       InstallConfig / DeploymentProfile (CapabilityBindings)
       Dependency ──▶ (producer→consumer DAG edge)
       Run (+ RunGroup)
       StateSnapshot / OutputSnapshot
       Deployment
       Activity
```

## Space / Source / Connection

- **Space** ([§4](../core-spec.md#4-space)) は owner namespace (`@handle`)。members / sources / connections /
  installations / dependency graph / policy / activity と optional billing を持つ。初回ログインで personal Space を
  自動作成する。
- **Source** ([§6](../core-spec.md#6-source)) は Space-scoped な Git repository 登録 (`url` / `defaultRef` /
  `defaultPath` / optional `authConnectionId`)。core は GitHub 非依存で、repository identity は `GitAddress`
  (`{ url, ref, path, credentialId? }`) のみ。user repo に Takosumi 独自 manifest を要求しない。
- **SourceSnapshot** ([§7](../core-spec.md#7-sourcesnapshot)) は ref を `resolvedCommit` に固定した immutable archive。
  `source_sync` run が Runner Container 内で `git ls-remote` → archive → digest → R2_SOURCE 保存し、worker は結果だけ
  記録する。
- **Connection** ([§8](../core-spec.md#8-connection)) は外部接続 (Git HTTPS token / Git SSH key / Cloudflare API
  token / AWS assume-role / static / manual)。scope は `operator` (instance 全体の default) か `space`。
  credential value は SecretBlob として暗号化保存し、public ledger には出さない。
- **CapabilityBinding** ([§9](../core-spec.md#9-operator-default-connections)) は Installation が capability
  (`source` / `compute` / `dns` / `storage` / `database` / `secrets`) ごとに mode を選ぶ:
  `default` (operator default に解決) / `connection` (明示 Connection) / `manual` (値直指定) / `disabled`。
  Installation ごとの binding map は `DeploymentProfile` に持つ。

## Installation / InstallConfig

**Installation** ([§5](../core-spec.md#5-installation)) は Space 直下の OpenTofu 実行単位 (`@space/name`、
1 Installation = 1 OpenTofu root/state)。`App` / `Environment` / `InstallProfile` lanes は廃止され、`environment` は
Installation の column (`UNIQUE(space_id, name, environment)`)。Installation は current pointer を持つ:
`currentDeploymentId` / `currentStateGeneration` (generation guard cursor) / `currentOutputSnapshotId`。status は
`installing` / `active` / `stale` / `error` / `destroying` / `destroyed`。

**InstallConfig** ([§11](../core-spec.md#11-installconfig)) は「この Source をどう扱うか」の service-side DB config。
install type ([§10](../core-spec.md#10-install-type): `core` / `opentofu_module` / `opentofu_root` / `app_source`)、
trust level (`official` / `trusted` / `space` / `raw`)、build、variable mapping、output allowlist、policy を持つ。

## Dependency / DependencySnapshot

**Dependency** ([§14](../core-spec.md#14-dependency-graph)) は producer Installation の outputs から consumer の inputs
への DAG edge。正本は D1 ledger。mode ([§15](../core-spec.md#15-dependency-modes)):

- `variable_injection` (標準): producer OutputSnapshot を読み consumer の `.auto.tfvars.json` を生成。
- `remote_state` (同一 Space のみ): producer state を read-only materialize し `terraform_remote_state` で読む。
- `published_output` (Space 間): OutputShare 経由で variable として注入。`remote_state` / `published_output` は post-MVP。

**DependencySnapshot** ([§17](../core-spec.md#17-dependencysnapshot)) は plan 時に依存入力を固定する。各 entry は
producer の `stateGeneration` / `outputSnapshotId` / `outputDigest` / `valuesDigest` と固定 `values` を持つ。mode は
`strict` (production default — apply 時に producer state generation が動いていたら fail) か `pinned` (preview / dev
default)。apply はこの snapshot を検証する (invariant 9)。

## Run + RunGroup

単一の **runs ledger** が retired な PlanRun/ApplyRun split を置き換え、kind は `type` に入る
([§19](../core-spec.md#19-run))。`type`: `source_sync` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`。`status`: `queued` / `running` / `waiting_approval` / `succeeded` / `failed` /
`cancelled` / `expired`。

Run が pin / 記録するもの: `sourceSnapshotId` / `dependencySnapshotId` / `baseStateGeneration` / `planDigest` /
`planArtifactKey` / `policyStatus` (`pass` / `warn` / `deny`)。`installationId` は spec 上 NOT NULL だが、`source_sync`
は Installation に bind するまで Source-scoped なため contract では optional (core-conformance.md 参照)。

`type` による §19 Run projection の含意:

- **plan-kind** (`plan` / `destroy_plan`): SourceSnapshot + DependencySnapshot を pin し plan artifact を残す。
  approval gate なら `waiting_approval`。成功しても infrastructure は変わらない。
- **apply-kind** (`apply` / `destroy_apply`): 必ず saved plan を実行し、plan digest / source snapshot / dependency
  snapshot / state generation を検証してから適用する (invariants 6-10)。destroy は 2-phase
  (`destroy_plan` → approval → `destroy_apply`、invariant 16)。

**RunGroup** ([§19](../core-spec.md#19-run)) は DAG をまたぐ複数 Run を順序付ける (例: stale propagation 後の Space
update)。`type`: `space_update` / `installation_install` / `installation_update` / `installation_destroy` /
`migration`。`graphJson` に実行順を記録する。

## Generation guard

各 Installation の tfstate 世代は **StateSnapshot** ([§20](../core-spec.md#20-statesnapshot)) で表す。暗号化 object は
R2_STATE の `.../envs/{environment}/states/{generation:8桁}.tfstate.enc` に置き、`current.json` を atomic に更新する。
`UNIQUE(installation_id, environment, generation)` が guard:

```text
plan:  baseStateGeneration = currentStateGeneration
apply: currentStateGeneration == plan.baseStateGeneration  でなければ拒否
```

apply 成功時に generation を +1 し、新 StateSnapshot を書く。

## OutputSnapshot projection

apply 後に `tofu output -json` を取得し、**OutputSnapshot** ([§16](../core-spec.md#16-outputsnapshot)) として 3 lane に
projection する:

- `rawOutputArtifactKey` — raw outputs は **暗号化 artifact** (R2_ARTIFACTS)。ledger には鍵だけ。
- `spaceOutputs` — 同一 Space dependency が消費する projection。
- `publicOutputs` — UI / install summary / external display 用の projection。

projection は sensitive-flag check → InstallConfig `outputAllowlist` → type validation を通す。sensitive 値は明示
policy なしにどちらの projection にも入らない (invariants 11-12)。Space 間共有は必ず `OutputShare`
([§18](../core-spec.md#18-outputshare)) を経由する (invariant 13)。`outputDigest` は projection に対する digest で、
stale propagation ([§24](../core-spec.md#24-stale-propagation)) を駆動する。

## Deployment

**Deployment** ([§21](../core-spec.md#21-deployment)) は成功した apply の immutable record。`applyRunId` /
`sourceSnapshotId` / `dependencySnapshotId` / `stateGeneration` / `outputSnapshotId` と公開済み `outputsPublic` を
参照する。失敗した apply は Deployment にならない。status transition:

```text
active ─▶ superseded     (後続 apply が current pointer を奪う)
active ─▶ rolled_back     (rollback apply 後)
active ─▶ destroyed       (destroy_apply 後)
```

current Deployment pointer は Installation に保存される。

## Activity

**Activity** ([§27](../core-spec.md#27-d1-schema) `audit_events`) は Space-scoped な public 監査証跡。
`installation.created` / `run.plan_created` / `run.applied` / `dependency.created` / `installation.stale` /
`run_group.created` などの action を記録する。WHAT を記録し、credential 値や resolved output 値は記録しない。
run-level の内部 trace (`DeployControlAuditEvent`) とは別 type。

詳細は [`core-spec.md`](../core-spec.md) を参照。run の実行フローは
[Runner profiles](./runner-profiles.md) (= 内部 execution profile、§22 Runner architecture)。
