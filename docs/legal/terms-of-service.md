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

Takosumi OSS and Takosumi for Operators do not include compatibility APIs,
Gateway-backed managed resources, official billing, official usage metering, or
official support/abuse workflows. Those are Takosumi Cloud-only features and are
governed by the Takosumi Cloud operator terms when used.

Self-hosted operators may replace this page with their own terms. If a hosted
operator publishes separate signed terms, those operator terms take precedence
for that hosted deployment.
