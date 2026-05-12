# API Key Management

This page is retained as a link-compatible migration stub.

End-user, account, installation, and dashboard API keys belong to the operator's
account plane (reference implementation: Takosumi Accounts in
`takosumi-cloud/`). The takosumi kernel only accepts operator-configured deploy
credentials for its public deploy/artifact routes and internal runtime-agent
credentials for control-plane RPC.

References:

- `takosumi/docs/reference/env-vars.md`
- `takosumi/docs/reference/kernel-http-api.md`
- `takosumi-cloud/docs/accounts-service.md`
