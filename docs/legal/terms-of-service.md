# Takosumi Terms of Service

Takosumi is an open-source OpenTofu-native control plane. The hosted operator
of a Takosumi platform worker is responsible for the commercial terms,
acceptable-use policy, any operator-run billing outside OSS Takosumi, and
support commitments for that hosted service.

For the Takosumi reference platform, these terms apply to account access,
dashboard use, control-plane API use, Runner operations, and account-plane
projection exposed through the same composed Takosumi origin. They do not grant
ownership of user repositories, OpenTofu state, provider accounts, StateVersion
records, or Capsule Outputs to the operator.

Provider credentials remain scoped to ProviderConnections selected by
ProviderBindings for a Capsule Run. ProviderConnection, Secret, and vault
records are backing material; they do not grant broad operator access to user
provider accounts. Account-plane projection material must not be embedded in
OpenTofu outputs.

Takosumi OSS may include Compatibility API framework, compatibility profiles,
Resource Shape APIs, adapter contracts, and usage-event emission. Official
managed target pools, Takosumi-owned native resource internals, enforced
billing/payment, official usage metering sold as a service, and official
support/abuse workflows are Takosumi for Operator / Takosumi Cloud operation
features and are governed by the relevant hosted operator terms when used.

## Takosumi Cloud commercial terms

Takosumi Cloud is a hosted digital service. It does not ship physical goods.
When a customer purchases a hosted plan or a credit pack, the account receives
plan access, managed resource access, or USD-denominated Takosumi Cloud usage
credit.

Takosumi Cloud usage credit is not a cash account, stored-value account, or
withdrawable balance. It may be used only for eligible Takosumi Cloud managed
resource usage. Free, trial, or promotional credit has no cash value.

Published pricing is available on the Takosumi website pricing section. Unless
the checkout screen states otherwise, the card statement descriptor is
`TAKOSUMI`. Customers can review the amount, currency, and plan before
checkout completes.

Monthly hosted plans renew until cancelled. Cancellation stops future renewals;
already-started billing periods and consumed usage credit are handled under the
[Cancellation Policy](./cancellation-policy.md) and
[Refund Policy](./refund-policy.md).

Support, billing, cancellation, and refund requests should be sent to
`support@takosumi.com`. Do not send provider tokens, private keys, API keys, or
other secret values by email.

Self-hosted operators may replace this page with their own terms. If a hosted
operator publishes separate signed terms, those operator terms take precedence
for that hosted deployment.
