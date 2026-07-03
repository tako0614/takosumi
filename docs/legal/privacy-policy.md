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

For Takosumi Cloud, payment processing is handled by Stripe. Takosumi Cloud may
store Stripe customer, subscription, checkout, invoice, receipt, payment status,
and billing event identifiers needed to operate billing, support, refunds,
fraud prevention, audit, and account recovery. Takosumi Cloud does not store
raw card numbers in the Takosumi repository or control-plane database.

Support requests may include account email, Workspace / Project / Capsule /
Run identifiers, timestamps, invoice or receipt identifiers, and the message
body provided by the requester. Customers should not send provider credentials,
API keys, private keys, or other secret values through email support.

Hosted operators are responsible for their own subprocessors, retention policy,
incident response, legal notices, and any commercial billing they choose to run
outside OSS Takosumi. Takosumi Cloud official billing and managed resources are
Cloud-only closed services. Self-hosted operators control their own data plane
and may replace this page with their organization-specific privacy policy.
