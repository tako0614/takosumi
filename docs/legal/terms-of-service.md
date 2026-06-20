# Takosumi Terms of Service

Takosumi is an open-source OpenTofu-native control plane. The hosted operator
of a Takosumi platform worker is responsible for the commercial terms,
acceptable-use policy, billing terms, and support commitments for that hosted
service.

For the Takosumi reference platform, these terms apply to account access,
dashboard use, deploy-control API use, operator-provided runtime services, and
Service Graph token projection exposed through the same Takosumi origin. They
do not grant ownership of user repositories, OpenTofu state, provider accounts,
or Capsule outputs to the operator.

Provider credentials remain scoped to Provider Connections selected by
Installation provider connection bindings. Connection, Vault, and SecretBlob
records are backing material; they do not grant broad operator access to user
provider accounts.
Runtime service tokens are issued through Service Graph ServiceGrant or
account-plane projection paths and must not be embedded in OpenTofu outputs.

Self-hosted operators may replace this page with their own terms. If a hosted
operator publishes separate signed terms, those operator terms take precedence
for that hosted deployment.
