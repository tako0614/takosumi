# Takosumi Privacy Policy

Takosumi stores account, Workspace, Project, Capsule, Source, ProviderConnection,
CredentialRecipe, ProviderBinding, Secret metadata, Run, StateVersion, Output,
Runner, quota/showback, and AuditEvent records needed to operate the control
plane. Secret values such as provider credentials, API keys, bearer tokens, and
private keys are stored behind the configured vault or secret-store boundary and
are not exposed through public outputs.

Takosumi may process Git URLs, commits, module paths, ProviderConnection /
CredentialRecipe / ProviderBinding decisions, plan/apply evidence, usage or
showback records, and dashboard session data. Raw OpenTofu state and raw outputs
are treated as protected control-plane artifacts; public projections are
allowlisted.

Hosted operators are responsible for their own subprocessors, retention policy,
incident response, legal notices, and any commercial billing they choose to run
outside OSS Takosumi. Takosumi Cloud official billing and managed resources are
Cloud-only closed services. Self-hosted operators control their own data plane
and may replace this page with their organization-specific privacy policy.
