# Supply Chain Trust

このページは install / deploy 時に「何を信用しているか」 を 1 本の chain of custody として固定します。 ecosystem の
trust model は **TLS + digest pin + 1 つの signing domain (OIDC)** の組み合わせで、 universal signing model は採用
しません。 これは design-principles § 6 と整合します。

## 1. Trust Boundaries

| Boundary               | Evidence                                                   | 取得機構           | Owner                            |
| ---------------------- | ---------------------------------------------------------- | ------------------ | -------------------------------- |
| source identity        | git URL / immutable ref / commit SHA                       | digest pin         | installer                        |
| app metadata           | `.takosumi/app.yml` sha256                                 | digest pin         | installer / Accounts             |
| publisher identity     | publisher id / homepage / optional verified status         | TLS + policy       | Accounts / install-source policy |
| artifact build         | workflow run id / artifact URI / image digest              | digest pin         | takosumi-git or external CI      |
| compiled manifest      | compiled Shape manifest sha256                             | digest pin         | installer                        |
| provider catalog       | CatalogRelease descriptor digest                           | digest pin (operator config) | operator / kernel  |
| provider resolution    | ResolvedProviderDecision                                   | kernel ledger      | kernel                           |
| installation ownership | AppInstallation source / binding / grant records           | append-only ledger | Accounts                         |
| install bootstrap      | one-time opaque launch token (Accounts `/consume`)         | TLS + ledger       | Accounts + app                   |
| runtime session        | OIDC ID token                                              | signed (1 domain)  | Accounts (issuer)                |

## 2. Chain Of Custody

Install path は次の順に evidence を pin します。

1. Git URL と immutable ref を resolve し、 commit SHA を pin する。
2. `.takosumi/app.yml` を parse し、 sha256 を計算する。
3. publisher metadata を Accounts / install-source policy で評価する。
4. `.takosumi/manifest.yml` を authoring compute manifest として parse する。
5. workflow / external CI が artifact URI または image digest を生成する。
6. binding / secret / artifact placeholder を materialize する。
7. compiled Shape manifest digest を計算する。
8. AppInstallation ledger に source commit / app manifest digest / compiled manifest digest / bindings / grants を保存する。
9. kernel が CatalogRelease digest と provider resolution を記録する。
10. runtime bootstrap を行う:
    - install 直後: one-time opaque launch token を Accounts が発行 → app が `/consume` 経由で redeem (TLS)
    - 以後の session: OIDC ID token (Accounts issuer 署名)。

この chain の途中に mutable ref、 unresolved placeholder、 unverified catalog digest、 unexplained provider decision
が残る場合は current contract として扱いません。

## 3. Signing Domain (1 only)

ecosystem で署名を発行する domain は **OIDC ID token のみ** に限定します。

| Domain        | Signer                   | Verifier          | 用途         |
| ------------- | ------------------------ | ----------------- | ------------ |
| OIDC ID token | Takosumi Accounts issuer | app / API gateway | user session |

OIDC を選んだ理由: 業界標準 (RFC 6749 / 8252 等) との互換性。 Keycloak / Auth0 等を upstream IdP として組み込む path、
3rd party tool との interop、 cross-domain federation 等が標準 tooling で動くこと。

**署名で扱わない boundary** (TLS / digest pin で扱う):

- launch token: one-time opaque token + Accounts `/consume` (OAuth authorization code grant 相当)
- catalog release: operator-pinned sha256 + TLS fetch
- provider endpoint URL / webhook URL: 個別 signing なし
- service descriptor / namespace export resolution: signing なし、 audit に record
- 3rd party app distribution (future marketplace): default は marketplace API trust (TLS)、 publisher direct signing は
  optional future extension

universal signing model (provider endpoint 署名 / service descriptor 署名 / 全 package 署名等) は採用しません。 各
trust boundary は最小限の機構で成立させ、 鍵管理と blast radius を縮小します。

## 4. Launch Token (opaque token model)

Install 直後の auto sign-in は OAuth authorization code grant 風の **one-time opaque token** を redirect carrier として
使い、 redeem を TLS で行います。

```text
1. install ready → Accounts が 32-byte random token を発行:
     { jti, installationId, accountId, sub, redirect_uri, expires_at, used: false }
   TTL は 5 分、 1 installation あたり active token は 1 個に制限。

2. takosumi-git / installer が user browser を app に redirect:
     https://<app>/<install_redirect_uri>?launch_token=<opaque>

3. app が launch_token を受領し、 Accounts に redeem:
     POST <accounts-base>/v1/installations/<installationId>/launch-token/consume
     Content-Type: application/json
     { "token": "<opaque>", "redirect_uri": "<expected>" }
   通信は TLS、 server cert で Accounts identity を確認。

4. Accounts:
   - token が存在し installationId と match するか
   - redirect_uri が発行時の値と一致するか
   - 有効期限内か
   - used が false か → atomic に true に変更 (single transaction)
   いずれか failure で 400 / 410 を返し、 token は無効化。

5. Accounts が成功時に返す:
     { account_id, space_id, sub, scope, session_jwt? }
   app は session を作成。
```

JWS / 公開鍵 verify / audience claim 検証は不要。 app は Accounts の TLS endpoint だけを trust すれば良い。 これは
OAuth 2.0 RFC 6749 の authorization code grant flow と本質的に同じ pattern。

### 4.1 セキュリティ性質

- **one-time**: `used` flag が atomic 操作で flip するため、 同 token の二重 consume は確実に拒否される
- **redirect_uri 拘束**: token は発行時に redirect_uri を bound、 別の URL に redirect された token は consume 不可
  (典型的な token theft + redirect attack を防ぐ)
- **短命**: TTL 5 分以下、 leak しても window が短い
- **TLS 必須**: token を carry する URL も redeem call も TLS で保護

JWS 版と比べた trade-off:

| 性質             | JWS 版                     | opaque token 版 (current)  |
| ---------------- | -------------------------- | -------------------------- |
| 鍵管理           | issuer + JWKS rotation     | なし                        |
| offline 検証     | 可 (app が local verify)   | 不可 (Accounts に redeem 要) |
| install bootstrap latency | low                | low (1 回の TLS round trip) |
| export migration | source 鍵持ち越し問題あり  | なし (鍵自体無い)           |
| 実装複雑度       | 高 (JWS + JWKS + verify lib) | 低 (TLS + DB lookup)      |

install 直後の 1 回限り bootstrap で offline 検証は不要なので、 opaque token を default にしています。

## 5. Digest Invariants

次の digest は AppInstallation / Deployment evidence で説明可能である必要があります。

- `appManifestDigest`: `.takosumi/app.yml` の sha256
- `compiledManifestDigest`: kernel に渡した compiled Shape manifest の sha256
- artifact digest: OCI image digest、 bundle hash、 または workflow artifact hash
- `catalogReleaseDigest`: operator が config に pin した catalog の sha256
- policy / provider resolution input digest

rollback は mutable tag を再解決しません。 保存済み compiled manifest digest と artifact digest を再 apply します。

## 6. Catalog Release Trust

shape / provider / template の release (catalog) は operator-pinned sha256 で trust を取ります。

```text
1. operator が deploy する kernel host の config に catalog digest を pin:
     CATALOG_DIGEST=sha256:abc123...
     CATALOG_URL=https://jsr.io/@takos/takosumi-plugins/0.7.0
2. kernel が catalog を TLS fetch、 sha256 を計算
3. config digest と一致しなければ reject (fail-closed)
4. AppInstallation / Deployment evidence に catalog digest を pin
```

これは container image digest と同じ pattern。 operator が「どの version を信頼するか」 を明示し、 kernel は fetch
結果が digest と一致することだけを verify します。 publisher signing は不要。

dynamic registry (operator が runtime に catalog version を切り替える) や multi-mirror が必要になった場合は、 future
RFC で publisher signing domain を追加することは可能です。 v1 default は static operator pin。

## 7. Marketplace Trust (future)

3rd party publisher の app distribution (Phase 2.x の marketplace 機能) は default では **marketplace API を trusted
authority とする TLS trust** で扱います:

- user が marketplace 上で「verified publisher」 を信頼する
- marketplace は publisher metadata、 verified status、 takedown 状態を API で公開
- consumer は TLS で marketplace API を叩き、 install 可否を判断

publisher direct signing (marketplace を bypass して publisher 鍵で verify) は **optional future extension**。 air-gapped
install / cypherpunk 用途で必要なら RFC で追加します。 v1 default は marketplace trust。

## 8. Current Gaps

このページは trust chain の target contract です。 current implementation では次の領域に gap が残り得ます。

- launch token の opaque-token migration: 既存 implementation は JWS。 migration は
  [Install Lifecycle Roadmap](../../../takosumi-cloud/docs/install-lifecycle-roadmap.md) を参照
- third-party CI artifact provenance attestation: SLSA-level の attestation は v1 では digest pin のみ
- future marketplace の publisher direct signing path
- export bundle の provider data restore integrity

gap は chain を曖昧にする理由ではなく、 release gate で partial として扱う対象です。
