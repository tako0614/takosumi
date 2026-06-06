# Takosumi Core Conformance

> [`core-spec.md`](./core-spec.md) に対する適合状況 (conformance / gap) を記録します。 本書は正本 spec ではなく、
> spec に対する現状の map です。 spec と矛盾した場合は spec が優先します。

## 状態区分

- **conformant**: 現状の code/test で満たしている。
- **in-progress**: 当該 milestone で実装中。
- **pending**: 後続 milestone。 未実装または未強制。

---

## 1. milestone gap table

| 領域 | spec § | 状態 | 補足 |
| --- | --- | --- | --- |
| 単一 Worker (in-process call) | §1.2 / §4 | conformant | control plane は単一 Worker、 module は in-process 結合。 |
| async queue lifecycle + DLQ | §10.1 | conformant | queue + lease + DLQ (`status: "dead"`) が稼働。 |
| Container runner OpenTofu 1.11.8 + provider mirror | §9.3 / §17 | conformant | runner image に OpenTofu 1.11.8、 provider は filesystem mirror から init。 |
| build phase credential-zero | §3.1 / §8.4 / §18.3 | conformant | build phase mint は常に空。 |
| source archive digest + generation guard | §6.2 / §11.2 | conformant | archive digest 計算と generation guard が稼働。 |
| vault per-phase mint | §8 | conformant | Connection seal + provider mint。 source/build/tofu の phase 分離は M1 で完成。 |
| plan-JSON policy v1 | §10.2 / §13 | conformant | plan を JSON 化して policy 評価 (v1)。 |
| output projection (allowlist) | §14 | conformant | DeploymentOutput を allowlist で projection。 |
| generated root (rootgen) | §9.2 | conformant | `opentofu_module` の generated root 構築。 |
| cloudflare provider Connection | §8 | conformant | provider Connection (cloudflare) を mint 可能。 |
| URL policy | §7.1 | conformant | `file://` / `git://` / `ext::` / embedded credential の拒否を強制。 |
| **M1 source foundation** | §6.1 / §7 / §10.2 | in-progress | Source/SourceSnapshot store、 mint phase 化 (source git-only)、 webhook、 scheduled poll、 runner `source_sync`。 |
| **M2 model + state** | §6.3-§6.10 / §11 | in-progress | App/Environment/Run 統一、 coordination lease の厳密化、 R2_STATE 分離、 SecretBlob 暗号化、 destroy 2-stage。 |
| M3 public `/api` surface | §15 | pending | source/app/environment/connection/run の public route。 |
| M4 hybrid flow | §9.1 | pending | `opentofu_module` + `app_source` 連携。 |
| M5 `app_source` build 完全対応 | §3.1 / §9.1 | pending | build -> image -> generated root deploy の完成。 |
| M6 policy 8 層 | §13 | pending | resource allowlist / scope boundary / quota の完成。 |
| M7 hardening | §18 | pending | 全 security invariant の網羅 enforcement + test。 |
| M8 repo layout / docs | §21 | pending | layout / docs の最終化。 |

---

## 2. security invariant map

各 invariant (§18) を enforcing code / test に map します。 未強制のものは pending と記します。

| # | invariant | 状態 | enforcing code / test |
| --- | --- | --- | --- |
| 1 | forge 非依存 (`GitAddress` のみ) | conformant | core に forge 固有 identifier なし。 root `scripts/check-no-legacy-names.mjs` が `githubInstallationId` 等の再導入を拒否。 |
| 2 | trusted Worker / untrusted Container 境界 | conformant | runner には mint された scoped credential のみ渡す (`src/service/adapters/vault/mod.ts`)。 |
| 3 | build phase は credential-zero | conformant | build mint 常に空。 `src/service/domains/deploy-control/template_run_test.ts` / `async_run_lifecycle_test.ts`。 |
| 4 | source phase は git credential のみ | in-progress | source phase mint を git-kind に限定 (M1)。 vault: `src/service/adapters/vault/mod.ts`。 |
| 5 | tofu phase は git credential を渡さない | in-progress | plan/apply/destroy は provider のみ。 vault mint policy で強制 (M1 で phase 判定を完成)。 |
| 6 | mint policy は vault 内で判定 | conformant | mint は `src/service/adapters/vault/mod.ts` 内で評価し caller 主張を信用しない。 |
| 7 | secret は SecretBlob で seal、 raw 非返却 | in-progress | seal は稼働、 公開 API の raw 非返却は `src/service/api/deploy_control_connection_routes_test.ts` で検証。 暗号化 backend は M2。 |
| 8 | SSH は `StrictHostKeyChecking=yes` 強制 | in-progress | known_hosts + strict host key を source phase で強制 (M1 source_sync)。 |
| 9 | credential を arg/URL に書かない (askpass/key file) | in-progress | HTTPS は askpass file、 SSH は key file で渡す (M1)。 |
| 10 | plan artifact は immutable、 apply は再 plan しない | conformant | reviewed `tfplan` artifact を復元して apply。 `src/service/domains/deploy-control/async_run_lifecycle_test.ts`。 |
| 11 | apply は plan digest + generation guard を満たすときだけ | conformant | expected guard 検証。 `src/service/domains/deploy-control/mod_test.ts` / `async_run_lifecycle_test.ts`。 |
| 12 | `opentofu_root` は auto-apply しない | pending | raw root flow は M4 以降。 auto-apply 禁止 policy を §13 に定義済み、 enforcement は pending。 |
| 13 | `local-exec` / `external` は forbidden-by-default | pending | policy layer 5 の forbidden 一覧。 enforcement は M6。 |
| 14 | Space scope boundary 強制 | in-progress | cross-Space Connection/Source 参照拒否。 store レベル enforcement を M2 で完成。 |
| 15 | log / output に secret を含めない | conformant | output projection allowlist (`src/service/domains/outputs/projection.ts`)。 log redaction の網羅は M7。 |

---

## 3. enforcing artifacts (reference)

- URL policy: `src/service/domains/sources/url-policy.ts` (+ `url-policy_test.ts`)。
- vault mint / seal: `src/service/adapters/vault/mod.ts` (+ `mod_test.ts`)。
- async run lifecycle (digest / generation guard / immutable plan artifact):
  `src/service/domains/deploy-control/async_run_lifecycle_test.ts`。
- template run (build cred-zero path): `src/service/domains/deploy-control/template_run_test.ts`。
- archive digest: `src/service/adapters/source/digest.ts` / `src/service/adapters/object-storage/digest.ts`。
- output projection: `src/service/domains/outputs/projection.ts`。
- public connection routes (raw secret 非返却): `src/service/api/deploy_control_connection_routes_test.ts`。
- forge 非依存 guard: root `scripts/check-no-legacy-names.mjs`。
