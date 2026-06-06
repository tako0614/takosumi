# Takosumi Core Conformance

> [`core-spec.md`](./core-spec.md) (2026-06-06 全面改訂: Space 直下 Installation DAG モデル) に対する適合状況
> (conformance / gap) を記録します。 本書は正本 spec ではなく、 spec に対する現状の map です。 spec と矛盾した場合は
> spec が優先します。

## 状態区分

- **conformant**: 現状の code/test で満たしている。
- **in-progress**: 当該 milestone で実装中。
- **pending**: 後続 milestone。 未実装または未強制。

## 実装 milestone

旧 spec (lanes モデル: App / Environment / InstallProfile) で実装済みの基盤は、 新 spec の語彙へ migrate して流用する。
milestone は次のとおり。

| milestone | 内容 | spec § |
| --- | --- | --- |
| M0 | spec 全面置換 + conformance reset + ecosystem 語彙更新 | 全体 |
| M1 | §28 物理再構成 (worker/src + packages + runner-image + opentofu-modules) | §28 / §29 |
| M2 | 新 contract 型 (Space / Installation / InstallConfig / CapabilityBinding / Dependency / OutputSnapshot / Run / RunGroup) | §4-§21 |
| M3 | モデル移行: lanes 廃止、 §27 logical schema、 runs 統合、 Installation lease | §5 / §19 / §27 |
| M4 | Connections 再編: operator defaults + CapabilityBinding 解決 | §8 / §9 |
| M5 | install types 完成: core / opentofu_module / opentofu_root / app_source | §10 / §13 |
| M6 | Dependency DAG + DependencySnapshot + variable_injection | §14 / §15 / §17 |
| M7 | OutputSnapshot + stale propagation + RunGroup basic | §16 / §19 / §24 |
| M8 | Policy basic + Activity | §25 |
| M9 | `/api` surface + external install link + Space wire-up | §12 / §30 |
| M10 | Dashboard (Space / Installations / Graph / Install flow) | §31 |
| M11 | conformance 更新 + reference docs 追従 + 全体 gate | 全体 |

---

## 1. milestone gap table

| 領域 | spec § | 状態 | 補足 |
| --- | --- | --- | --- |
| 正本 spec 採用 (Space 直下 Installation DAG モデル) | 全体 | conformant | M0 で全面置換。 |
| 単一 Worker (fetch/queue/scheduled + DO + Container) | §3 / §22 | conformant | 旧 spec M0 から維持。 物理 layout の §28 準拠は M1。 |
| async queue lifecycle + DLQ | §22 / §23 | conformant | queue + lease + DLQ が稼働 (旧実装からの流用)。 |
| Container runner OpenTofu + provider mirror | §22 | conformant | runner image に OpenTofu 1.11.8、 filesystem mirror。 |
| Source / SourceSnapshot | §6 / §7 | conformant | 旧 M1 実装を流用。 URL policy / webhook / polling / source_sync 稼働。 |
| Connection vault + per-phase mint | §8 / §32 | conformant | SecretBlob seal + phase mint (source→git / build→空 / plan・apply→provider)。 |
| 暗号化 state + generation guard | §20 / §32 | conformant | R2_STATE + current.json + StateSnapshot 世代管理 (旧 M2 実装を流用)。 |
| **M1 物理再構成 (§28 layout)** | §28 / §29 | conformant | worker/src (entry/durable) + packages/{schema,rootgen,graph} + runner-image + opentofu-modules を §28 配置に移動、 binding/class 名を §29 に整合。 `src/service/domains/*` の `worker/src/modules/*` への移設は各 milestone でその domain を書き換える際に行う (M3+)。 |
| M2 新 contract 型 | §4-§21 | pending | |
| M3 モデル移行 (lanes 廃止 / §27 schema / runs 統合) | §5 / §19 / §27 | conformant | lanes (App/Environment/InstallProfile) 削除、 Space/InstallConfig/Installation (UNIQUE(space_id,name,environment)) store + service + /v1 routes、 単一 runs table (kind 列 + run_json、 SQL/D1)、 installation lease (`installation:{id}:{env}`)、 stateScope/R2 key を §20 に re-key、 D1 を §27 実テーブル化。 create-on-apply legacy path は削除 (Installation-first)。 |
| M4 operator defaults + CapabilityBinding | §8 / §9 | conformant | Connection.scope (operator/space、 operator は spaceId なし + AAD `__operator__`)、 operator_connection_defaults CRUD (`/v1/operator-connection-defaults`、 unrestricted bearer のみ)、 ConnectionsService.resolveCapabilities (default/connection/manual/disabled + cross-space 拒否)、 vault mint の capability pool (caller 主張を信用せず id を再検証)。 manual values の module input 接続と rootgen capability alias は M5。 |
| M5 install types (core / app_source 完成) | §10 / §13 | conformant | 公式 modules: core (provider-free 基盤、 4 標準 outputs) / cloudflare-worker-service / cloudflare-r2-storage / cloudflare-static-site / aws-s3-storage。 rootgen `generateInstallationRoot` が installType + 解決済み capability から §13 provider alias を生成 (**per-alias credential 分離は deferred** — 同一 provider の alias は env credential を共有)。 app_source は InstallConfig.build を credential-zero build phase に thread (template.build より優先)。 opentofu_root は snapshot を root として実行 (templateBinding 禁止)。 manual binding values は template 宣言済み input に限り variableMapping を override。 公式 seed: core / talk / files。 |
| M6 Dependency DAG + variable_injection | §14 / §15 / §17 | conformant | dependencies domain (same-space / variable_injection のみ、 cycle 拒否 = takosumi-graph)、 plan 時 DependencySnapshot (strict=production / pinned)、 値は template inputs / raw variables に injection、 apply は invariant 9 検証 (dependency_snapshot_stale / _tampered)。 remote_state / published_output / cross_space は not_implemented (MVP 外)。 |
| M7 OutputSnapshot + stale + RunGroup | §16 / §19 / §24 | conformant | apply が OutputSnapshot を記録 (spaceOutputs = 非 sensitive 全 outputs、 publicOutputs = allowlist projection、 raw は DO が暗号化して §26 key に書く)。 outputDigest 変化で downstream を stale 化。 RunGroup basic: space plan-update が topo 順に plan Run を発行、 status は member runs から計算 (orchestration daemon なし)。 |
| M8 Policy basic + Activity | §25 | pending | |
| M9 `/api` surface + install link | §12 / §30 | pending | 現状は旧 `/v1` surface。 |
| M10 Dashboard | §31 | pending | |
| MVP 外 (OutputShare / remote_state / published_output / backup / drift_check) | §15 / §18 / §33 | pending | §34 の MVP 外宣言どおり。 型と logical schema のみ先行定義。 |

### 意図的な divergence (gap ではない)

- Postgres/D1 の物理テーブルは既存規約の `takosumi_` prefix を維持 (D1 は素の §27 名)。 §27 名は logical schema。
- `Deployment.sourceSnapshotId` / `outputSnapshotId` は §27 では NOT NULL だが、 raw plan path の残存 (M9 で削除) と OutputSnapshot 未実装 (M7) の間 optional。
- `Run.installationId` / `environment` は §27 では NOT NULL だが、 Source-scoped な `source_sync` 行のため optional。
- 内部 run 型 (PlanRun/ApplyRun) は internal 実装語彙として残る (public は §19 Run projection のみ)。
- 承認規則: installation-driven plan は environment が `preview` 以外なら approval 必須 (旧 lanes の production default を引き継いだ暫定。 policy 層の action policy (M8) が正式な置き場) (M1 で binding 名を §29 に揃える。 realized operator config の追従は
  `takosumi-private/platform/wrangler.toml` 側の operator 作業)。

---

## 2. security invariant map

各 invariant (§32) を enforcing code / test に map します。 未強制のものは pending と記します。
(file path は M1 物理再構成前の現行 path。 M1 で worker/src / packages へ移動後に更新する。)

| # | invariant | 状態 | enforcing code / test |
| --- | --- | --- | --- |
| 1 | Public API returns no raw secret | conformant | `src/service/api/deploy_control_connection_routes_test.ts`。 |
| 2 | User source build runs in Container | conformant | runner container (`runner-image/`)。 Worker は build を実行しない。 |
| 3 | Build phase receives build inputs only | conformant | build mint 常に空。 vault `mintForPhase` + `phase_mint_test.ts`。 |
| 4 | Source phase receives Git credential only | conformant | source phase mint を git-kind に限定。 `src/service/adapters/vault/mod.ts`。 |
| 5 | Plan/apply phase receives provider credentials only | conformant | plan/apply/destroy は provider のみ。 vault mint policy で強制。 |
| 6 | Apply uses saved plan | conformant | reviewed `tfplan` artifact を復元して apply。 `async_run_lifecycle_test.ts`。 |
| 7 | Apply verifies plan digest | conformant | expected guard 検証。 `async_run_lifecycle_test.ts`。 |
| 8 | Apply verifies source snapshot | conformant | apply 時の snapshot id / digest 再検証。 |
| 9 | Apply verifies dependency snapshot | conformant | `#verifyDependencySnapshot` (strict freshness + valuesDigest tamper check)。 `dependency_run_test.ts`。 |
| 10 | Apply verifies state generation | conformant | generation guard。 `installation_run_test.ts` / `apply_lease_test.ts`。 |
| 11 | Output publication uses allowlist | conformant | output projection allowlist (`src/service/domains/outputs/projection.ts`)。 OutputSnapshot 化は M7。 |
| 12 | Sensitive output sharing requires explicit policy | conformant | sensitive flagged 出力は spaceOutputs / publicOutputs のどちらにも入らない (leak test in `installation_run_test.ts`)。 explicit 共有 policy は OutputShare (MVP 外) で導入。 |
| 13 | Cross-Space sharing uses OutputShare | pending | OutputShare は MVP 外。 cross-space dependency は M6 で作成拒否として強制。 |
| 14 | State, plan, raw outputs are encrypted artifacts | conformant | state/plan/raw outputs すべて暗号化 artifact (raw outputs は DO が §26 key に seal、 `runner_state_r2_test.ts`)。 |
| 15 | Logs pass through redaction | in-progress | output projection は稼働。 log redaction の網羅は M8 以降。 |
| 16 | Destroy uses destroy plan and approval | conformant | destroy 2-phase (destroy_plan → approval → destroy_apply)。 |

---

## 3. enforcing artifacts (reference)

- URL policy: `src/service/domains/sources/url-policy.ts` (+ `url-policy_test.ts`)。
- vault mint / seal: `src/service/adapters/vault/mod.ts` (+ `phase_mint_test.ts`)。
- async run lifecycle (digest / generation guard / immutable plan artifact):
  `src/service/domains/deploy-control/async_run_lifecycle_test.ts`。
- state encryption: `worker/src/state_crypto.ts`。
- coordination lease: `worker/src/durable/CoordinationObject.ts`。
- output projection: `src/service/domains/outputs/projection.ts`。
- generated root: `packages/rootgen/src/mod.ts`。
- forge 非依存 guard: root `scripts/check-no-legacy-names.mjs`。
