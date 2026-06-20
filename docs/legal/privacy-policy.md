# Takosumi Privacy Policy

Takosumi stores account, Space, Source, Connection metadata, Installation, Run,
RunGroup, Deployment, OutputSnapshot, billing, and audit records needed to
operate the control plane. Secret values such as provider credentials, API keys,
bearer tokens, and private keys are stored behind the configured vault or
secret-store boundary and are not exposed through public outputs.

Takosumi may process Git URLs, commits, module paths, provider catalog
decisions, plan/apply evidence, usage records, and dashboard session data. Raw
OpenTofu state and raw outputs are treated as protected control-plane artifacts;
public projections are allowlisted.

Hosted operators are responsible for their own subprocessors, retention policy,
incident response, and legal notices. Self-hosted operators control their own
data plane and may replace this page with their organization-specific privacy
policy.
