# Supply Chain Trust {#supply-chain-trust}

::: info
内部設計メモ。public contract は [Installer API](./installer-api.md) を参照。
:::

## Trust Boundaries {#trust-boundaries}

| Boundary | Evidence | Mechanism | Owner |
| --- | --- | --- | --- |
| source identity | git URL / resolved commit, prepared archive digest, or local source summary | git / HTTPS / local operator path | installer |
| dry-run guard | `planSnapshotDigest` | Installer API dry-run | service |
| prepared source handoff | workflow run id / installer-computed archive digest | build service + installer | build service / installer |
| operator inventory | PlatformService inventory / adapter config | operator bootstrap | operator distribution |
| binding resolution | selected PlatformService / binding snapshot | operator resolver | operator distribution + service record |
| installation ownership | owner / Space / binding / permission records | append-only account ledger | operator account layer |
| Deployment record | source summary / plan snapshot / binding snapshot / non-secret outputs | Installer API apply | service |
| runtime bootstrap | launch token / OIDC / workload config | distribution-defined HTTPS + ledger | operator distribution |

## Chain Of Custody {#chain-of-custody}

1. Source input (`git` / `prepared` / `local`) is selected.
2. For `git` and `prepared`, the Installer API resolves immutable source identity. For `local`, it records an operator-local source summary and relies on `planSnapshotDigest` for dry-run/apply consistency.
3. The operator resolver evaluates requested bindings against PlatformService inventory.
4. Dry-run returns `InstallPlan` and `planSnapshotDigest`.
5. Apply verifies source pins / source digest / `planSnapshotDigest`.
6. `POST /v1/installations` records the first Deployment for an Installation, or `POST /v1/installations/{id}/deployments` records a later Deployment.
7. Runtime bootstrap uses output data defined by the selected operator distribution.

The chain records source identity and operator binding decisions before apply.

## Runtime Identity / HTTPS {#runtime-identity-https}

runtime identity の出力データは operator distribution が定義します。Takosumi では OIDC と launch token を使いますが、それは Cloud distribution の仕様です。operator execution code の取得・検証・lockfile・vendoring は operator policy で扱います。Takosumi v1 の public trust chain は HTTPS と recorded digest を基本にします。

## Digest Invariants {#digest-invariants}

Public trust chain は source identity と `planSnapshotDigest` を guard として使います。operator account layer が projection ledger を持つ場合、その projection は current Deployment の source identity、plan snapshot、binding snapshot、public non-secret outputs を参照して説明します。

- source pin / digest: git source は commit SHA、prepared source は archive payload sha256。`local` source は portable source byte digest を持ちません。
- `planSnapshotDigest`: dry-run で review した source summary、repo metadata、binding resolution、publication plan、changes の snapshot digest。
- implementation / policy resolution evidence: operator / reference implementation が Deployment を説明するために保持する opaque evidence。
- optional asset digest: operator-owned asset extension evidence。

rollback は mutable ref を再解決しません。retained Deployment の source summary、plan snapshot、binding snapshot、public non-secret outputs を authority として current pointer を戻します。

## Operator Implementation Loading {#operator-implementation-loading}

Operator / reference implementation は PlatformService inventory と adapter wiring を使って binding を解決し、deploy 時に解決結果を Deployment の記録として紐づけます。

Reference service example:

```text
1. operator imports backend adapter subpaths in its distribution
2. operator boots Takosumi service with a plugin array
3. service rejects unresolved required bindings before runtime side effects
4. reference runtime-agent topology resolves connector work from operator inventory
5. Deployment record stores source, plan, binding snapshot, outputs, and status
```

operator が `/v1/artifacts` を mount する場合、その route は asset extension として扱います。
