# Self-host template: Terms of Service

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

Takosumi OSS may include compatibility profiles, Interfaces, provider-neutral
Stack execution, and showback events. Generic Offering and active Resource/Form
Host lifecycle are not current OSS authority. An operator governs its own BYOC
deployment and support terms; Takosumi Hosted governs any retail/payment/client
composition it offers, and Takoserver governs its managed supply, provider
credentials, meter, price, quota, SLA, and support terms.

Self-hosted operators may replace this page with their own terms. If a hosted
operator publishes separate signed terms, those operator terms take precedence
for that hosted deployment.
