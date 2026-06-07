# Model

Takosumi の data model は **Space 直下の OpenTofu Capsule DAG** です。正本は
[`core-spec.md`](../core-spec.md)。contract の正本は
`packages/schema/src/*.ts` で、本ページが矛盾した場合は schema と spec が優先します。

```text
Space
  └─ Installation (= Capsule + generated root + tfstate + outputs)
       Source / SourceSnapshot
       CapsuleCompatibilityReport
       InstallConfig / DeploymentProfile (CapabilityBindings)
       Dependency ──▶ (producer→consumer DAG edge)
       Run (+ RunGroup)
       StateSnapshot / OutputSnapshot
       Deployment
       Activity
```

## Space / Source / Connection

- **Space** は owner namespace (`@handle`)。members / sources / connections /
  installations / dependency graph / policy / activity と optional billing を持つ。初回ログインで personal Space を
  自動作成する。
- **Source** は Space-scoped な Git repository 登録 (`url` / `defaultRef` /
  `defaultPath` / optional `authConnectionId`)。core は GitHub 非依存で、repository identity は `GitAddress`
  (`{ url, ref, path, credentialId? }`) のみ。user repo に Takosumi 独自 manifest を要求しない。
- **SourceSnapshot** は ref を `resolvedCommit` に固定した immutable archive。
  `source_sync` run が Runner Container 内で `git ls-remote` → archive → digest → R2_SOURCE 保存し、worker は結果だけ
  記録する。
- **Connection** は外部接続 (Git HTTPS token / Git SSH key / Cloudflare API
  token / AWS assume-role / static / manual)。scope は `operator` (instance 全体の default) か `space`。
  credential value は SecretBlob として暗号化保存し、public ledger には出さない。
- **CapabilityBinding** は Installation が capability
  (`source` / `compute` / `dns` / `storage` / `database` / `secrets`) ごとに mode を選ぶ:
  `default` (operator default に解決) / `connection` (明示 Connection) / `manual` (値直指定) / `disabled`。
  Installation ごとの binding map は `DeploymentProfile` に持つ。

## Installation / InstallConfig

**OpenTofu Capsule** は Git-hosted OpenTofu module-compatible configuration。Takosumi は SourceSnapshot を
Normalizer / Gate に通し、generated root から child module として呼ぶ。compatibility は `ready` /
`auto_capsulized` / `needs_patch` / `unsupported`。

**Installation** は Space 直下の OpenTofu 実行単位 (`@space/name`、
1 Installation = Capsule + generated root + tfstate + outputs)。Installation は environment を持ち、
`UNIQUE(space_id, name, environment)` で同一 Space 内の実行 namespace を守る。Installation は current pointer を持つ:
`currentDeploymentId` / `currentStateGeneration` (generation guard cursor) / `currentOutputSnapshotId`。status は
`pending` / `active` / `stale` / `error` / `disabled` / `destroyed`。

**InstallConfig** は Capsule 実行の service-side DB config。trust level (`official` / `trusted` / `space` / `raw`)、
`modulePath`、`normalization`、variable mapping、output allowlist、policy を持つ。public behavior は常に
Capsule + generated root。

## Dependency / DependencySnapshot

**Dependency** は producer Installation の outputs から consumer の inputs
への DAG edge。正本は D1 ledger。mode:

- `variable_injection` (標準): producer OutputSnapshot を読み consumer の `.auto.tfvars.json` を生成。
- `remote_state` (同一 Space のみ): producer state を read-only materialize し `terraform_remote_state` で読む。
- `published_output` (Space 間): OutputShare 経由で variable として注入。

**DependencySnapshot** は plan 時に依存入力を固定する。各 entry は
producer の `stateGeneration` / `outputSnapshotId` / `outputDigest` / `valuesDigest` と固定 `values` を持つ。mode は
`strict` (production default — apply 時に producer state generation が動いていたら fail) か `pinned` (preview / dev
default)。apply はこの snapshot を検証する (invariant 9)。

## Run + RunGroup

単一の **runs ledger** がすべての実行を記録し、kind は `type` に入る。
`type`: `source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`。`status`: `queued` / `running` / `waiting_approval` / `succeeded` / `failed` /
`cancelled` / `expired`。

Run が pin / 記録するもの: `sourceSnapshotId` / `dependencySnapshotId` / `baseStateGeneration` / `planDigest` /
`planArtifactKey` / `policyStatus` (`pass` / `warn` / `deny`)。Installation-bound Runs は `installationId` を持ち、
Source sync は SourceSnapshot を作って後続の Installation run に渡す。

`type` による Run projection の含意:

- **compatibility-kind** (`compatibility_check`): SourceSnapshot を pin し、credential mint 前に Normalizer /
  no-credential init/scan / Gate 結果を
  CapsuleCompatibilityReport として残す。provider credential は mint しない。
- **plan-kind** (`plan` / `destroy_plan`): SourceSnapshot + DependencySnapshot を pin し plan artifact を残す。
  approval gate なら `waiting_approval`。成功しても infrastructure は変わらない。
- **apply-kind** (`apply` / `destroy_apply`): 必ず saved plan を実行し、plan digest / source snapshot / dependency
  snapshot / state generation を検証してから適用する (invariants 6-10)。destroy は 2-phase
  (`destroy_plan` → approval → `destroy_apply`、invariant 16)。

**RunGroup** は DAG をまたぐ複数 Run を順序付ける (例: stale propagation 後の Space
update)。`type`: `space_update` / `installation_install` / `installation_update` / `installation_destroy` /
`migration`。`graphJson` に実行順を記録する。

## Generation guard

各 Installation の tfstate 世代は **StateSnapshot** で表す。暗号化 object は
R2_STATE の `.../envs/{environment}/states/{generation:8桁}.tfstate.enc` に置き、state object を先に書いてから
`current.json` を更新する。`current.json` 更新だけが失敗した場合は、次回 restore 時に digest metadata 付きの最新 generation
object から pointer を reconcile する。
`UNIQUE(installation_id, environment, generation)` が guard:

```text
plan:  baseStateGeneration = currentStateGeneration
apply: currentStateGeneration == plan.baseStateGeneration  でなければ拒否
```

apply 成功時に generation を +1 し、新 StateSnapshot を書く。

## OutputSnapshot projection

apply 後に `tofu output -json` を取得し、**OutputSnapshot** として 3 lane に
projection する:

- `rawOutputArtifactKey` — raw outputs は **暗号化 artifact** (R2_ARTIFACTS)。ledger には鍵だけ。
- `spaceOutputs` — 同一 Space dependency が消費する projection。
- `publicOutputs` — UI / install summary / external display 用の projection。

projection は sensitive-flag check → InstallConfig `outputAllowlist` → type validation を通す。sensitive 値は明示
policy なしにどちらの projection にも入らない。Space 間共有は必ず `OutputShare`
を経由する。`outputDigest` は projection に対する digest で stale propagation を駆動する。

## Deployment

**Deployment** は成功した apply の immutable record。`applyRunId` /
`sourceSnapshotId` / `dependencySnapshotId` / `stateGeneration` / `outputSnapshotId` と公開済み `outputsPublic` を
参照する。失敗した apply は Deployment にならない。status transition:

```text
active ─▶ superseded     (後続 apply が current pointer を奪う)
active ─▶ rolled_back     (rollback apply 後)
active ─▶ destroyed       (destroy_apply 後)
```

current Deployment pointer は Installation に保存される。

## Activity

**Activity** (`audit_events`) は Space-scoped な public 監査証跡。
`installation.created` / `run.plan_created` / `run.applied` / `dependency.created` / `installation.stale` /
`run_group.created` などの action を記録する。WHAT を記録し、credential 値や resolved output 値は記録しない。
run-level の redacted internal trace とは別の public projection。

詳細は [`core-spec.md`](../core-spec.md) を参照。run の実行フローは
[Internal execution profiles](./runner-profiles.md)。
