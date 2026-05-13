# API Key Management

> このページでわかること: API key の発行・ローテーション・失効の仕様。

end-user / account / installation / dashboard 向けの API key は operator の
account plane が所有する (reference 実装: `takosumi-cloud/` の Takosumi
Accounts)。 takosumi kernel が受け付けるのは次の 2 種類のみ:

- public な deploy / artifact route 向けに operator が設定する deploy credential
- control-plane RPC 用の internal runtime-agent credential

## 関連ページ

- [Environment Variables](/reference/env-vars)
- [Kernel HTTP API](/reference/kernel-http-api)
- `takosumi-cloud/docs/accounts-service.md`
