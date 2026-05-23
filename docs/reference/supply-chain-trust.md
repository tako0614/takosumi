# サプライチェーン信頼 {#supply-chain-trust}

> このページでわかること: AppSpec install / deploy 時の chain of custody。

## 信頼境界 {#trust-boundaries}

| Boundary               | Evidence                                           | 取得機構                     | Owner                            |
| ---------------------- | -------------------------------------------------- | ---------------------------- | -------------------------------- |
| source identity        | git URL / immutable ref / commit SHA               | git / HTTPS                  | installer                        |
| AppSpec                | `.takosumi.yml` sha256                             | installer parse              | installer                        |
| publisher identity     | publisher id / homepage / optional verified status | TLS + policy                 | Accounts / install-source policy |
| prepared source build  | workflow run id / source snapshot digest           | build service / external CI  | build service / external CI      |
| implementation config  | `kindAliases` / provider package imports           | TypeScript import / lockfile | operator distribution            |
| provider resolution    | resolved implementation / connector decision       | kernel ledger                | kernel / runtime-agent           |
| installation ownership | Installation source / binding / grant records      | append-only ledger           | Accounts / kernel                |
| install bootstrap      | one-time opaque launch token                       | TLS + ledger                 | Accounts + app                   |
| runtime session        | OIDC ID token                                      | signed                       | Accounts issuer                  |

## チェーン・オブ・カストディ {#chain-of-custody}

1. Source URL / prepared source is selected.
2. Installer resolves immutable source identity and reads `.takosumi.yml`.
3. AppSpec schema and component graph are validated.
4. Prepared source snapshot / build service outputs carry source identity
   evidence where applicable.
5. Operator implementation config and provider / connector resolution are
   recorded.
6. `POST /v1/installations` creates Installation + first Deployment, or
   `POST /v1/installations/{id}/deployments` records a later Deployment.
7. Runtime bootstrap uses the Accounts-owned launch-token / OIDC flow.

The chain records immutable source identity and provider decisions before apply.

## Identity / HTTPS {#identity-https}

runtime identity は Accounts issuer の OIDC ID token を基本とする。reference
provider adapter は operator distribution が通常の TypeScript module として
import して渡す。package manager lockfile、HTTPS、private registry、vendoring
などは operator policy で扱う。

## Launch トークン {#launch-token}

Install 直後の auto sign-in は one-time opaque token を redirect carrier として
使い、 redeem を TLS で行う。

```text
1. install ready → Accounts issues opaque token
2. user browser is redirected to the app with launch_token
3. app redeems the token against Accounts
4. Accounts atomically marks token as used and returns installation/account context
5. app starts its local session or OIDC flow
```

## Digest 不変条件 {#digest-invariants}

次の digest は Installation / Deployment evidence で説明可能でなければならない。

- `appSpecDigest`: `.takosumi.yml` の sha256
- source digest: git commit digest または prepared source snapshot sha256
- DataAsset digest: optional operator-owned DataAsset extension の sha256
- policy / provider resolution input digest

rollback は mutable tag を再解決しない。保存済み Deployment evidence と source
digest を使って新しい rollback Deployment を作る。

## Operator implementation loading {#operator-implementation-loading}

component kind、provider implementation、runtime-agent connector は operator
distribution が接続します。Takosumi reference kernel は起動時に渡された
`kindAliases` と `plugins` を使い、deploy 時に解決結果を Deployment evidence
に記録します。

```text
1. operator imports provider packages in its distribution
2. operator boots kernel with kindAliases + plugins
3. kernel rejects unresolved aliases, missing providers, and duplicate providers
4. runtime-agent resolves connector descriptors from operator inventory
5. Installation / Deployment evidence records provider / connector resolution
```

operator が `/v1/artifacts` を mount する場合、その route は DataAsset extension
として扱います。
