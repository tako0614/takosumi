# アカウント管理プロファイル {#operator-account-plane-profile}

この profile は Cloud-compatible な account layer surface です。Takosumi
は Source / Installation / Deployment / Installer API を管理し、Takosumi
は account behavior を管理します。

## Profile Surfaces

| Surface | Cloud definition |
| --- | --- |
| PlatformService inventory | identity、billing、runtime、storage などの Space-visible capability |
| Deploy facade | approved Installer API call を broker する account/admin workflow |
| Account API | session、PAT、Space ownership、projection、event、export/import、dashboard |
| OIDC | issuer、upstream identity、per-Installation client、key rotation |
| Billing | owner record、portal、usage reporting、metering authorization |
| Projection ledger | Takosumi Installation / Deployment state の account-facing projection |

credential は family 間で流用しません。public response と export bundle は raw
secret value ではなく ref または public field を返します。
