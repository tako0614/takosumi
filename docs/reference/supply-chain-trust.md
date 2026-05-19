# サプライチェーン信頼 {#supply-chain-trust}

> このページでわかること: AppSpec install / deploy 時の chain of custody。

## 信頼境界 {#trust-boundaries}

| Boundary               | Evidence                                           | 取得機構                     | Owner                            |
| ---------------------- | -------------------------------------------------- | ---------------------------- | -------------------------------- |
| source identity        | git URL / immutable ref / commit SHA               | digest pin                   | installer                        |
| AppSpec                | `.takosumi.yml` sha256                             | digest pin                   | installer                        |
| publisher identity     | publisher id / homepage / optional verified status | TLS + policy                 | Accounts / install-source policy |
| artifact build         | workflow run id / artifact URI / image digest      | digest pin                   | external CI / installer          |
| provider catalog       | CatalogRelease descriptor digest                   | digest pin (operator config) | operator / kernel                |
| provider resolution    | ResolvedProviderDecision                           | kernel ledger                | kernel                           |
| installation ownership | Installation source / binding / grant records      | append-only ledger           | Accounts / kernel                |
| install bootstrap      | one-time opaque launch token                       | TLS + ledger                 | Accounts + app                   |
| runtime session        | OIDC ID token                                      | signed                       | Accounts issuer                  |

## チェーン・オブ・カストディ {#chain-of-custody}

1. Source URL / catalog entry / local source is selected.
2. Installer resolves immutable source identity and reads `.takosumi.yml`.
3. AppSpec schema and component graph are validated.
4. Artifact references / build outputs are pinned by digest where applicable.
5. Provider catalog digest and provider resolution are recorded.
6. `POST /v1/installations` creates Installation + first Deployment, or
   `POST /v1/installations/{id}/deployments` records a later Deployment.
7. Runtime bootstrap uses the Accounts-owned launch-token / OIDC flow.

The chain must not contain mutable source refs without a resolved commit,
unexplained provider decisions, or unverified catalog digests.

## 署名ドメイン {#signing-domain}

ecosystem で署名を発行する domain は OIDC ID token を基本とする。 catalog /
artifact / AppSpec evidence は TLS + digest pin で扱う。 universal signing model
(provider endpoint 署名 / service descriptor 署名 / 全 package 署名等) は採用し
ない。

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
- artifact digest: OCI image digest、bundle hash、workflow artifact hash
- `catalogReleaseDigest`: operator が config に pin した catalog の sha256
- policy / provider resolution input digest

rollback は mutable tag を再解決しない。保存済み Deployment evidence と artifact
digest を使って新しい rollback Deployment を作る。

## Catalog Release の信頼 {#catalog-release-trust}

shape / provider の release (catalog) は operator-pinned sha256 で trust
を取る。

```text
1. operator pins catalog digest in kernel host config
2. kernel TLS-fetches catalog and computes sha256
3. mismatch rejects boot/apply fail-closed
4. Installation / Deployment evidence records catalog digest
```

publisher signing は v1 default では不要。 dynamic registry や multi-mirror が
必要になった場合は future RFC で signing domain を追加できる。
