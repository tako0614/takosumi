# Supply Chain Trust

このページは install / deploy 時に「何を信用しているか」を 1 本の chain of custody として固定します。署名は限定された
domain で使い、すべてを署名で解決する 設計にはしません。

## 1. Trust Boundaries

| Boundary               | Evidence                                                   | Owner                            |
| ---------------------- | ---------------------------------------------------------- | -------------------------------- |
| source identity        | git URL / immutable ref / commit                           | installer                        |
| app metadata           | `.takosumi/app.yml` digest                                 | installer / Accounts             |
| publisher identity     | publisher id / homepage / optional signing key fingerprint | Accounts / install-source policy |
| artifact build         | workflow run id / artifact URI / image digest              | takosumi-git or external CI      |
| compiled manifest      | compiled Shape manifest digest                             | installer                        |
| provider catalog       | CatalogRelease digest / signature                          | operator / kernel                |
| provider resolution    | ResolvedProviderDecision                                   | kernel                           |
| installation ownership | AppInstallation source / binding / grant records           | Accounts                         |
| runtime launch         | launch token JWS / OIDC ID token                           | Accounts                         |

## 2. Chain Of Custody

Install path は次の順に evidence を pin します。

1. Git URL と immutable ref を resolve し、commit SHA を pin する。
2. `.takosumi/app.yml` を parse し、digest を計算する。
3. publisher metadata を Accounts / install-source policy で評価する。
4. `.takosumi/manifest.yml` を authoring compute manifest として parse する。
5. workflow / external CI が artifact URI または image digest を生成する。
6. binding / secret / artifact placeholder を materialize する。
7. compiled Shape manifest digest を計算する。
8. AppInstallation ledger に source commit / app manifest digest / compiled manifest digest / bindings / grants
   を保存する。
9. kernel が CatalogRelease trust と provider resolution を記録する。
10. launch token JWS または OIDC ID token で runtime bootstrap / login を行う。

この chain の途中に mutable ref、unresolved placeholder、unsigned catalog release、unexplained provider decision
が残る場合は current contract として 扱いません。

## 3. Signature Domains

current design の署名 domain は限定します。

| Domain                     | Signer                          | Verifier               | 用途                                    |
| -------------------------- | ------------------------------- | ---------------------- | --------------------------------------- |
| OIDC ID token              | Takosumi Accounts issuer        | app / API gateway      | user session                            |
| launch token JWS           | Takosumi Accounts launch issuer | installed app          | install bootstrap                       |
| CatalogRelease             | trusted catalog publisher       | kernel                 | shape / provider / template release pin |
| future marketplace package | publisher key registry          | marketplace / Accounts | app distribution trust                  |

provider endpoint descriptor に署名して discovery する model は current design では 使いません。provider trust は
CatalogRelease / implementation trust / operator policy の採用 decision として扱います。

## 4. Digest Invariants

次の digest は AppInstallation / Deployment evidence で説明可能である必要がある。

- `appManifestDigest`: `.takosumi/app.yml`
- `compiledManifestDigest`: kernel に渡した compiled Shape manifest
- artifact digest: OCI image digest、bundle hash、または workflow artifact hash
- CatalogRelease descriptor digest
- policy / provider resolution input digest

rollback は mutable tag を再解決しません。保存済み compiled manifest digest と artifact digest を再 apply します。

## 5. Current Gaps

この文書は trust chain の target contract です。current implementation では次の 領域に gap が残り得ます。

- future marketplace publisher verification UI
- third-party CI artifact provenance attestation
- end-to-end signed app package format
- export bundle provider data restore integrity

gap は chain を曖昧にする理由ではなく、release gate で partial として扱う対象です。
