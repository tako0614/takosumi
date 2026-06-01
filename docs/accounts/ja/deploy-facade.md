# Deploy Facade {#deploy-facade}

Takosumi Accounts deploy facade は Takosumi のアカウント管理/admin API surface です。workload の出力データでも platform service path でもありません。

facade は approved call を Takosumi Installer API に broker します。

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

## Boundary

| Surface                            | Owner                          |
| ---------------------------------- | ------------------------------ |
| Installer API endpoint contract    | Takosumi                       |
| account authorization              | Takosumi                 |
| approval / budget / billing policy | Takosumi                 |
| dashboard or admin workflow        | Takosumi                 |
| upstream Takosumi credential       | operator-private configuration |

## Approval Envelope

mutating facade request は Cloud-only confirmation を持ちます。

```json
{
  "source": {},
  "expected": {},
  "confirm": {
    "approvalDigest": "sha256:...",
    "costAck": true
  }
}
```

`source` と `expected` は Takosumi Installer API contract として forward します。 `confirm.*` は Cloud が消費し、manifest や Installer API surface ではありません。

`approvalDigest` は reviewed operation、Installation、app id、next source、 requested binding、policy / cost impact と一致しなければなりません。metered / paid change には `confirm.costAck: true` が必要です。

upstream Takosumi token は browser client、export bundle、Deployment output、 workload runtime material に返しません。
