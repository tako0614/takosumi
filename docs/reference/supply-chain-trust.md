# サプライチェーン信頼 {#supply-chain-trust}

::: info
内部設計メモ public contract は [Installer API](./installer-api.md) を参照。
:::

## 信頼境界 {#trust-boundaries}

| Boundary                | Evidence                                              | 取得機構                   | Owner                                              |
| ----------------------- | ----------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| source identity         | git URL / immutable ref / commit SHA                  | git / HTTPS                | installer                                          |
| manifest                | `.takosumi.yml` sha256                                | installer parse            | installer                                          |
| publisher identity      | publisher id / homepage / optional verified status    | HTTPS + policy             | operator account layer / install-source policy     |
| prepared source handoff | workflow run id / installer-computed archive digest   | build service + installer  | build service / installer                          |
| operator inventory      | kind alias table / execution binding config           | operator bootstrap         | operator profile                                   |
| execution resolution    | resolved kind / execution / connector decision        | operator-recorded evidence | operator profile; Takosumi links Deployment の記録 |
| installation ownership  | owner / Space / binding / permission records          | append-only account ledger | operator account layer                             |
| Deployment record       | manifestDigest / source identity / non-secret outputs | kernel Deployment record   | kernel                                             |
| runtime bootstrap       | operator-distribution bootstrap 出力データ            | HTTPS + ledger             | operator profile + app                             |
| runtime session         | operator-distribution identity 出力データ             | distribution-defined       | operator profile                                   |

## チェーン・オブ・カストディ {#chain-of-custody}

1. Source input (`git` / `prepared` / dev or operator-local `local`) is selected.
2. For `git` and `prepared`, the kernel Installer API resolves immutable source identity and reads `.takosumi.yml`. For dev/operator-local `local`, it records manifest drift guard only; `local` has no portable source byte digest.
3. manifest schema and component graph are validated.
4. For prepared source, build service / CI may record workflow, cache, and provenance evidence; the Installer-computed archive payload digest is the source identity recorded in the Deployment.
5. Operator inventory and execution resolution are recorded as operator の記録。
6. `POST /v1/installations` records the first Deployment for an Installation, or `POST /v1/installations/{id}/deployments` records a later Deployment.
7. Runtime bootstrap uses output data defined by the selected operator distribution.

The chain records immutable source identity and operator execution decisions before apply.

## Runtime Identity / HTTPS {#runtime-identity-https}

runtime identity の出力データは operator profile が定義します。Takosumi Cloud では OIDC と launch token を使いますが、それは Cloud distribution の仕様です。 operator execution code の取得・検証・lockfile・vendoring は operator policy で扱う。Takosumi v1 の public trust chain は HTTPS と recorded digest を基本にする。production / public surface と LAN dev hostname surface は HTTPS を使い、 `http://localhost` / `http://127.0.0.1` は single-host loopback dev だけで許容する。

## Runtime Bootstrap {#runtime-bootstrap}

Install 直後の redirect、auto sign-in、runtime credential handoff は operator distribution が持つ runtime bootstrap の出力データで扱います。core Installer API が記録するのは Deployment、source identity、manifest digest、public non-secret outputs です。operator-selected implementation の記録は Deployment の記録として紐づきます。Takosumi Cloud の launch token / OIDC bootstrap は Cloud distribution spec と launch-token app spec が定義します。入口は [Takosumi Cloud](./takosumi-cloud.md) です。

## Digest 不変条件 {#digest-invariants}

Public trust chain は source identity と `manifestDigest` を guard として使います。 operator account layer が projection ledger を持つ場合、その projection は current Deployment の source identity、`manifestDigest`、public non-secret outputs を参照して説明します。

- `manifestDigest`: `.takosumi.yml` raw file bytes の sha256。parsed manifest object の normalized digest ではない。
- source pin / digest: git source は commit SHA、prepared source は archive payload sha256。`expected.sourceDigest` は prepared source にだけ使う。 `local` source は portable source byte digest を持たず、`manifestDigest` だけを apply guard に使う dev/operator-local mode
- implementation / policy resolution evidence: operator / reference implementation が Deployment を説明するために保持する opaque evidence。Reference kernel may store structured digest families for replay / restore, while public wire compatibility uses the source pin/digest and `manifestDigest`.

optional asset digest は operator-owned asset extension evidence です。 current reference asset extension は sha256 を使います。Installer API v1 の public digest set は `manifestDigest` と source pin / digest を正本にし、 asset evidence は operator extension evidence として記録します。

rollback は mutable tag を再解決しない。retained Deployment の source pin、 `manifestDigest`、public non-secret outputs を authority として current pointer を戻し、operator / reference implementation は紐づく retained evidence で provider state を説明します。

## Operator implementation loading {#operator-implementation-loading}

component kind と binding は operator profile が接続します。 Operator / reference implementation は、operator inventory を使って kind alias / kind の定義 / binding を解決し、deploy 時に解決結果を Deployment の記録として紐づけます。その記録は source pin、manifest digest、resolved kind URI、selected implementation binding、operator policy decision、materialized outputs を後から説明するための operator record です。

Reference kernel example:

```text
1. operator imports kind packages in its distribution
2. operator boots reference kernel with kindAliases + reference adapter array
3. kernel rejects unresolved aliases, missing kind bindings, and duplicate adapters
4. reference runtime-agent topology resolves connector descriptors from operator inventory
5. deploy record records implementation / connector resolution
```

operator が `/v1/artifacts` を mount する場合、その route は asset extension として扱います。
