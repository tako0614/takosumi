# Takosumi Accounts {#takosumi-accounts}

Takosumi Accounts は takosumi に同梱される account management 実装です。
identity、OIDC issuer、account session、PAT、billing owner、launch token、
Installation ownership projection を提供します。

## Responsibilities

- stable account subject
- upstream IdP absorption
- OIDC issuer endpoints
- passkey account authentication
- personal access tokens
- billing owner records and usage authorization
- Cloud Installation projection ledger
- launch token issue / consume

これらの責務は Takosumi core には移しません。core は Source、Installation、
Deployment、Installer API に集中します。
