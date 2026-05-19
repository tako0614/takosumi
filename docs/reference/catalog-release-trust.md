# CatalogRelease Trust Model

> このページでわかること: CatalogRelease の trust model。 v1 では **operator-
> pinned sha256 digest + TLS fetch** で fail-closed に検証する。 publisher
> signing model は採用しない。

CatalogRelease は Takosumi v1 で「kind / materializer の release pin」 を Space
に adopt する単位。

## Trust model summary

ecosystem trust model は 「TLS + digest pin + 1 signing domain (OIDC)」 で、
OIDC ID token signing と install launch token signing は両方とも **Takosumi
Accounts** が所有する。 kernel が直接関わる signing は **CatalogRelease
verification のみ** であり、 これも publisher signing ではなく **operator-
pinned sha256 digest** で fail-closed に検証する。

```text
1. operator pins catalog digest in kernel host config (= CATALOG_DIGEST)
2. kernel TLS-fetches catalog and computes sha256
3. mismatch rejects boot/apply fail-closed
4. Installation / Deployment evidence records catalog digest
```

| Tier           | Verified by                            | Verifier      |
| -------------- | -------------------------------------- | ------------- |
| CatalogRelease | operator-pinned sha256 + TLS fetch     | kernel        |
| Connector      | operator config + TLS                  | runtime-agent |
| Implementation | digest pin (= artifact / image digest) | runtime-agent |

## Why not publisher signing

publisher signing model (= Ed25519 key enrollment / rotation / revocation list)
は v1 default では不要。 reasons:

- **single signing domain**: ecosystem 全体で OIDC ID token signing 1 つに
  集約することで、 verify path が複数になる cognitive cost を避ける。
- **operator agency**: operator が pin する digest が trust の root。 publisher
  side で signing key が rotate されても、 operator が digest を再 pin する
  までは何も変わらない (= fail-closed)。
- **simplicity**: kernel に key enrollment / rotation / revocation list 管理を
  持たない。

dynamic registry や multi-mirror catalog が必要になった場合は future RFC で
publisher signing domain を追加できる。 v1 では採用しない。

## Catalog digest workflow

### Enroll

```bash
# operator が catalog の digest を取得して pin
curl -fsSL https://example.com/catalog.json | sha256sum
# → 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

# kernel host config に pin
export CATALOG_URL=https://example.com/catalog.json
export CATALOG_DIGEST=sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

### Verify (= kernel boot / apply 時)

kernel は TLS で `CATALOG_URL` から fetch し、 bytes の sha256 を計算する。
`CATALOG_DIGEST` と mismatch なら boot / apply を fail-closed で reject する。

### Rotate

新 catalog を fetch → 新 digest を operator が pin → kernel reload。 publisher
側に「key rotation」 という概念は存在しない (= catalog 自体が版を持つ)。

### Revoke

operator が `CATALOG_DIGEST` を旧版に戻す (= rollback)、 または kernel host
config から削除する。 publisher 側に「revocation list」 を kernel が問い合わせる
仕組みは持たない。

## CatalogRelease descriptor

Space が adopt する descriptor 本体 (= operator-pinned digest と一致する catalog
body の中身):

```json
{
  "catalog": {
    "kinds": [
      { "uri": "https://takosumi.com/kinds/v1/worker", "version": "1.0.0" },
      { "uri": "https://takosumi.com/kinds/v1/postgres", "version": "1.0.0" }
    ],
    "materializers": [
      {
        "kindUri": "https://takosumi.com/kinds/v1/worker",
        "providerId": "@takos/cloudflare-workers",
        "version": "1.0.0"
      },
      {
        "kindUri": "https://takosumi.com/kinds/v1/worker",
        "providerId": "@takos/aws-fargate",
        "version": "1.0.0"
      }
    ]
  }
}
```

descriptor body そのものに署名は付かない。 trust の root は **operator が pin
した sha256 digest** だけ。

## Failure UX

| Failure                                       | Behavior                                                         |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `CATALOG_URL` fetch failure (DNS / TLS / 5xx) | boot / apply reject (`failed_precondition` HTTP 409)             |
| `CATALOG_DIGEST` mismatch                     | boot / apply reject、 audit `catalog-digest-mismatch`            |
| `CATALOG_DIGEST` unset                        | boot reject in `TAKOSUMI_ENVIRONMENT=production`、 dev では warn |
| catalog body schema invalid                   | boot reject、 audit `catalog-body-invalid`                       |

## Related architecture notes

- [Supply Chain Trust](./supply-chain-trust.md) — ecosystem-wide 「TLS + digest
  pin + 1 signing domain (OIDC)」 narrative
- [Storage Schema](./storage-schema.md) — CatalogRelease descriptor の
  persistence shape
- [Catalog Release Descriptor Model](./architecture/catalog-release-descriptor-model.md)
- [Connector Contract](./connector-contract.md) — runtime-agent 側 verify
