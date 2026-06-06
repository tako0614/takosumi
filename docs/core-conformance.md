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
| **M1 物理再構成 (§28 layout)** | §28 / §29 | in-progress | worker/src + packages + runner-image + opentofu-modules への移動。 alias seam 原子更新。 |
| M2 新 contract 型 | §4-§21 | pending | |
| M3 モデル移行 (lanes 廃止 / §27 schema / runs 統合) | §5 / §19 / §27 | pending | App / Environment / InstallProfile を Installation + InstallConfig に置換。 |
| M4 operator defaults + CapabilityBinding | §8 / §9 | pending | |
| M5 install types (core / app_source 完成) | §10 / §13 | pending | |
| M6 Dependency DAG + variable_injection | §14 / §15 / §17 | pending | |
| M7 OutputSnapshot + stale + RunGroup | §16 / §19 / §24 | pending | |
| M8 Policy basic + Activity | §25 | pending | |
| M9 `/api` surface + install link | §12 / §30 | pending | 現状は旧 `/v1` surface。 |
| M10 Dashboard | §31 | pending | |
| MVP 外 (OutputShare / remote_state / published_output / backup / drift_check) | §15 / §18 / §33 | pending | §34 の MVP 外宣言どおり。 型と logical schema のみ先行定義。 |

### 意図的な divergence (gap ではない)

- なし (M1 で binding 名を §29 に揃える。 realized operator config の追従は
  `takosumi-private/platform/wrangler.toml` 側の operator 作業)。

---

## 2. security invariant map

各 invariant (§32) を enforcing code / test に map します。 未強制のものは pending と記します。
(file path は M1 物理再構成前の現行 path。 M1 で worker/src / packages へ移動後に更新する。)

| # | invariant | 状態 | enforcing code / test |
| --- | --- | --- | --- |
| 1 | Public API returns no raw secret | conformant | `src/service/api/deploy_control_connection_routes_test.ts`。 |
| 2 | User source build runs in Container | conformant | runner container (`deploy/cloudflare/runner/`)。 Worker は build を実行しない。 |
| 3 | Build phase receives build inputs only | conformant | build mint 常に空。 vault `mintForPhase` + `phase_mint_test.ts`。 |
| 4 | Source phase receives Git credential only | conformant | source phase mint を git-kind に限定。 `src/service/adapters/vault/mod.ts`。 |
| 5 | Plan/apply phase receives provider credentials only | conformant | plan/apply/destroy は provider のみ。 vault mint policy で強制。 |
| 6 | Apply uses saved plan | conformant | reviewed `tfplan` artifact を復元して apply。 `async_run_lifecycle_test.ts`。 |
| 7 | Apply verifies plan digest | conformant | expected guard 検証。 `async_run_lifecycle_test.ts`。 |
| 8 | Apply verifies source snapshot | conformant | apply 時の snapshot id / digest 再検証。 |
| 9 | Apply verifies dependency snapshot | pending | DependencySnapshot は M6。 |
| 10 | Apply verifies state generation | conformant | generation guard。 `m2_environment_run_test.ts` 系。 |
| 11 | Output publication uses allowlist | conformant | output projection allowlist (`src/service/domains/outputs/projection.ts`)。 OutputSnapshot 化は M7。 |
| 12 | Sensitive output sharing requires explicit policy | pending | spaceOutputs / publicOutputs 分離と leak test は M7。 |
| 13 | Cross-Space sharing uses OutputShare | pending | OutputShare は MVP 外。 cross-space dependency は M6 で作成拒否として強制。 |
| 14 | State, plan, raw outputs are encrypted artifacts | conformant | state/plan は暗号化済み (旧 M2)。 raw outputs の暗号化 artifact 化は M7。 |
| 15 | Logs pass through redaction | in-progress | output projection は稼働。 log redaction の網羅は M8 以降。 |
| 16 | Destroy uses destroy plan and approval | conformant | destroy 2-phase (destroy_plan → approval → destroy_apply)。 |

---

## 3. enforcing artifacts (reference)

- URL policy: `src/service/domains/sources/url-policy.ts` (+ `url-policy_test.ts`)。
- vault mint / seal: `src/service/adapters/vault/mod.ts` (+ `phase_mint_test.ts`)。
- async run lifecycle (digest / generation guard / immutable plan artifact):
  `src/service/domains/deploy-control/async_run_lifecycle_test.ts`。
- state encryption: `deploy/cloudflare/src/state_crypto.ts`。
- coordination lease: `deploy/cloudflare/src/coordination_object.ts`。
- output projection: `src/service/domains/outputs/projection.ts`。
- generated root: `src/service/domains/rootgen/mod.ts`。
- forge 非依存 guard: root `scripts/check-no-legacy-names.mjs`。
