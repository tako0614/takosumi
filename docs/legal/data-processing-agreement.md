# Takosumi Data Processing Addendum

This Data Processing Addendum describes the baseline data-processing boundary
for the hosted Takosumi reference platform. It is intended for operators and
customers evaluating the hosted platform worker at `app.takosumi.com`.
Self-hosted operators may replace this page with their own organization-specific
DPA.

## Roles

The customer is the controller for account records, Git source metadata,
Provider Connection metadata, Capsule configuration, Run records, StateVersion
artifacts, Output records, billing records, and audit events that they submit to
or generate through Takosumi.

The hosted Takosumi operator acts as processor for the hosted control-plane
service. The operator processes customer data only to provide account access,
dashboard functionality, deploy-control API operations, OpenTofu/Terraform
execution, state/output storage, usage accounting, support, security, and abuse
prevention.

## Processing Scope

Takosumi may process:

- account identity and session metadata;
- Workspace, Project, Capsule, Source, ProviderConnection, ProviderBinding,
  Run, StateVersion, Output, Runner, and AuditEvent records;
- Git URLs, refs, commits, module paths, Credential Recipe and Provider Connection decisions, plan/apply
  evidence, usage records, and dashboard events;
- encrypted secrets and credential references needed to materialize temporary
  run-time env/file material;
- support and incident-response records when the customer contacts the operator.

Secret values such as provider credentials, API keys, bearer tokens, and private
keys are stored behind the configured vault or secret-store boundary. They are
not exposed through public outputs and are injected only into the selected
runner phase when required by the selected Credential Recipe.

## Security Measures

The hosted reference platform is designed around:

- encrypted secret storage;
- run-scoped credential materialization;
- state and output isolation by customer workspace;
- audit logging for account, provider connection, run, deployment, and operator
  actions;
- provider allowlists, source URL restrictions, runner egress policy, and
  redaction of credential material from public payloads and logs;
- backup and restore procedures for control-plane state.

## Subprocessors

The hosted reference platform may rely on infrastructure and service providers
for hosting, storage, authentication, email, billing, monitoring, incident
response, and support. The operator must publish the active subprocessor list
for the hosted deployment before opening general availability.

Self-hosted operators choose and control their own subprocessors.

## International Transfers

The hosted operator is responsible for documenting region choices, transfer
mechanisms, and customer-facing data residency commitments for the hosted
deployment. Takosumi OSS does not mandate a region or a subprocessors list.

## Retention And Deletion

Customers may request export or deletion of account and control-plane data. The
hosted operator must maintain procedures for export, deletion, backup retention,
and audit retention. Some records may be retained where required for security,
fraud prevention, billing, legal compliance, or audit integrity.

## Incident Notification

The hosted operator will investigate suspected unauthorized access to customer
data and notify affected customers according to the published incident-response
and support commitments for the hosted deployment.

## Precedence

If the hosted operator and customer enter into a separately signed data
processing agreement, that signed agreement takes precedence for the hosted
deployment.
