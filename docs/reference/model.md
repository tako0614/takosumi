# Model

Takosumi の data model は **Space 直下の OpenTofu Capsule DAG** です。正本は
[`core-spec.md`](../core-spec.md)。`contract/*.ts` は現実装の public contract subset を表し、正本 spec との差は
[`core-conformance.md`](../core-conformance.md) に implementation gap として記録します。

```text
Takosumi Instance
  ├─ Provider Templates
  └─ Space
       ├─ Source / SourceSnapshot
       ├─ Connection
       ├─ Provider Env Set
       └─ Installation (= Capsule + generated root + tfstate + outputs)
            CapsuleCompatibilityReport
            InstallConfig / DeploymentProfile / ProviderBinding resolution
            Dependency ──▶ (producer→consumer DAG edge)
            Run (+ RunGroup)
            StateSnapshot / OutputSnapshot
            Deployment
            Activity
```

## Space / Source / Provider / Connection

- **Space** は owner namespace (`@handle`)。members / sources / connections /
  installations / dependency graph / policy / activity と optional billing を持つ。初回ログインで personal Space を
  自動作成する。
- **Source** は Space-scoped な Git repository 登録 (`url` / `defaultRef` /
  `defaultPath` / optional `authConnectionId`)。core は GitHub 非依存で、repository identity は `GitAddress`
  (`{ url, ref, path, credentialId? }`) のみ。user repo に Takosumi 独自 manifest を要求しない。
- **SourceSnapshot** は ref を `resolvedCommit` に固定した immutable archive。
  `source_sync` run が Runner Container 内で `git ls-remote` → archive → digest → R2_SOURCE 保存し、worker は結果だけ
  記録する。
- **Provider Template** は OpenTofu provider source を credential sources、recommended env names、helper flows、policy に結びつける
  read-only template。user-facing credential source は `takosumi_managed` と `user_env_set` の2つだけ。Hosted Takosumi の
  Takosumi提供 default は Cloudflare only から始める。
- **Provider Env Set** は Space-owned Connection の一種。AWS / GCP / Cloudflare / GitHub / Kubernetes / 任意 provider の
  env values を write-only で受け取り、Vault が run / phase / provider scoped に mint する。OAuth / AssumeRole /
  impersonation は env set を作る・更新する・mint する helper flow であり、第3の provider kind ではない。
- **Connection** は Git credential または provider credential。Provider credential は Takosumi提供 default か
  Space-owned `user_env_set` から来る。OAuth / AssumeRole / impersonation / token vending はその Connection を
  作成・更新・mint する helper flow であり、credential source ではない。scope は `operator` (instance 全体の default) か `space`。
  credential value は SecretBlob として暗号化保存し、public ledger には出さない。status は
  `pending` / `verified` / `revoked` / `expired` / `error`。`expiresAt` がある Connection は期限切れ後の
  mint/test が fail-closed になり、期限内 mint は TTL evidence を audit に残す。
- **ProviderBinding** は Installation が OpenTofu provider source と任意 alias ごとに mode を選ぶ:
  `default` (operator default に解決) / `connection` (明示 Connection) / `manual` (値直指定) / `disabled`。
  binding list は Installation-scoped internal config として解決される。ProviderBinding は fail-closed で、`manual` /
  `disabled` / default-missing は Space-wide provider connection へ fallback せず plan/apply/destroy を止める。
- **DeploymentProfile** は Installation / environment ごとの ProviderBinding set。Space-owned Connection や operator
  default connection を provider ごとに解決するための public model。

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
`PolicyConfig.providerCredentials` は mint audit evidence を runner dispatch 前に検査する credential policy。operator
managed default は provider が対応する限り temporary / TTL evidence を要求する。Space-owned Connection は provider や
driver の性質により static token を許可できるが、ProviderBinding、Connection policy、provider template policy、
egress policy、runner class で境界付ける。`requireRootOnly` を有効化すると root-only evidence のない mint は
fail-closed にする。Runner は shared provider env payload と ambient provider env を tofu env に入れず、generated root の
`TF_VAR_<provider>_<alias>_<arg>` だけを通す。
unknown provider は Space-owned provider env set、provider allowlist / lockfile / mirror policy、egress policy、runner policy を
満たすまで runnable にならない。

## Dependency / DependencySnapshot

**Dependency** は producer Installation の outputs から consumer の inputs
への DAG edge。正本は D1 ledger。mode:

- `variable_injection` (標準): producer OutputSnapshot を読み consumer の `.auto.tfvars.json` を生成。
- `remote_state` (同一 Space のみ): plan 時に固定した producer StateSnapshot を read-only materialize し `terraform_remote_state` で読む。
- `published_output` (Space 間): OutputShare 経由で variable として注入。

**DependencySnapshot** は plan 時に依存入力を固定する。各 entry は
producer の `stateGeneration` / `outputSnapshotId` / `outputDigest` / `valuesDigest` と固定 `values` を持つ。`remote_state`
edge では `stateSnapshotId` / state object key / state digest も固定する。mode は
`strict` (production default — apply 時に producer state generation が動いていたら fail) か `pinned` (preview / dev
default)。apply はこの snapshot を検証し、`remote_state` は producer の latest ではなく plan 時に固定した state bytes を復元する。

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
- **apply-kind** (`apply` / `destroy_apply`): 必ず saved plan を実行し、plan digest / source snapshot /
  compatibility report / dependency snapshot / state generation を検証してから適用する。destroy は 2-phase
  (`destroy_plan` → approval → `destroy_apply`)。

**RunGroup** は DAG をまたぐ複数 Run を順序付ける (例: stale propagation 後の Space update / Space drift
check)。`type`: `space_update` / `space_drift_check` / `installation_install` / `installation_update` /
`installation_destroy` / `migration`。`graphJson` に実行順を記録する。

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

## Billing

Billing は Space 単位の ledger。`BillingSettings.mode` は `disabled` / `showback` / `enforce` で、`BillingPlan` は
typed `BillingPlanLimits` (`maxEstimatedCreditsPerRun` / `quota`) を持つ。Plan completion は active
`SpaceSubscription` の plan limits を評価し、`enforce` では reservation 作成前に超過を block、`showback` では audit evidence
として記録して続行する。Apply は credential mint 前に `CreditReservation` を検証し、成功時に `UsageEvent` と capture、失敗時に
release を記録する。Managed resource meter は period-scoped `managed_compute` / storage / artifact / backup / egress
`UsageEvent` を idempotent に記録する。

## Activity

**Activity** (`audit_events`) は Space-scoped な public 監査証跡。
`installation.created` / `run.plan_created` / `run.applied` / `dependency.created` / `installation.stale` /
`run_group.created` などの action を記録する。WHAT を記録し、credential 値や resolved output 値は記録しない。
run-level の redacted internal trace とは別の public projection。

詳細は [`core-spec.md`](../core-spec.md) を参照。run の実行フローは
[Operator execution boundaries](./operator-execution-boundaries.md)。
