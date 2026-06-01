# Takosumi Accounts {#takosumi-accounts}

Takosumi Accounts is the account management implementation packaged by
 takosumi. It provides identity, OIDC issuer, account sessions, PATs,
billing owner records, launch tokens, and Installation ownership projection.

## Responsibilities

- stable account subject
- upstream IdP absorption
- OIDC issuer endpoints
- passkey account authentication
- personal access tokens
- billing owner records and usage authorization
- Cloud Installation projection ledger
- launch token issue / consume

These responsibilities do not move into Takosumi core. Core stays focused on
Source, Installation, Deployment, and Installer API.
