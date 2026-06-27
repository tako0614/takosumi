# Takosumi Cloud Launch Brief

This launch brief defines what Takosumi Cloud is allowed to offer before the
platform access gate can move from closed to open.

Takosumi Cloud is the closed official hosted Takosumi for Operators deployment.
It is not the OSS control plane and it may contain Cloud-only billing, quota,
support, compatibility gateway, and managed resource modules.

## Target Customer

The initial target customer is a Takos or Takosumi user who wants a hosted
browser flow for installing Git-hosted OpenTofu Capsules without operating their
own Takosumi instance.

The user should be able to:

- arrive from `takos.jp` or an external install link;
- sign in with Google;
- review the Git URL, pinned ref, module path, compatibility result, and needed
  Provider Connections;
- add required Provider Connections through Workspace settings;
- run the hosted plan/apply flow only after explicit review;
- inspect Runs, logs, StateVersions, Outputs, and audit activity.

## Launch Scope

The initial open scope is deliberately narrow:

- one hosted platform worker at `https://app.takosumi.com`;
- Google as the only GA sign-in provider;
- Git URL sourced OpenTofu/Terraform Capsules;
- Provider Connections and Credential Recipes for supported existing providers;
- hosted runner pool for approved Capsules;
- Workspace settings for members, connections, billing, backups, and output
  sharing;
- public legal pages at `https://takosumi.com/docs/legal/*`.

Out of scope for the first open gate:

- public self-serve login before the code-enforced pre-GA allowlist is removed;
- arbitrary managed Cloud resources without explicit coverage;
- Cloudflare Compatibility Gateway public availability unless its provider and
  resource operation coverage has separate readiness evidence;
- GitHub OAuth as a sign-in provider;
- passkey sign-in as a GA provider; passkeys may remain implemented but disabled
  until a separate passkey UI and e2e readiness track is accepted;
- CLI-first onboarding for hosted customers;
- paid enforcement before Stripe, entitlement, invoice, dunning, refund, and
  support drills pass readiness.

## Launch Risk Controls

These controls are Cloud-only launch controls for the closed official hosted
deployment. They do not add billing, managed resources, compatibility gateways,
or official resource pools to OSS Takosumi or Takosumi for Operators.

Do not mark Takosumi Cloud open based on this section alone. Operator signoff,
legal signoff, provider drills, incident drills, Stripe flows, support mailbox
checks, restore drills, rollback drills, and security operation rehearsals must
still pass launch-readiness evidence.

### Usage Aggregation Policy

Policy reference:

```text
policy://takosumi-cloud/usage-aggregation/showback-v1
```

Takosumi Cloud aggregates customer-visible usage by Workspace. Capsule,
Project, Run, provider, and meter are dimensions used for drill-down, not payer
ownership.

The initial closed-GA aggregation window is daily UTC. Each aggregation job must
record:

- `workspace_id`
- `project_id` when available
- `capsule_id` when available
- meter id
- quantity
- source Run or platform event reference
- aggregation window start and end
- reconciliation timestamp

The aggregation job may run in `showback` mode while access is closed. It must
not block plan/apply/destroy until Stripe, entitlement, invoice,
failed-payment, dunning, refund, and support readiness have passed.

### Spend Cap

Spend cap reference:

```text
policy://takosumi-cloud/spend-cap/starter-closed-ga
```

Closed-GA starter Workspaces use a USD-denominated monthly spend cap in showback
mode. The default launch cap is:

```text
25 USD / Workspace / calendar month
```

While access is closed, exceeding the cap must create operator-visible evidence
and keep additional paid or managed resource usage blocked unless an operator
override is recorded. It must not silently open paid billing.

Paid enforcement requires billing-entitlement readiness. Until that passes,
spend-cap evidence proves only that the cap policy exists and is reviewable.

### LLM And Tool Usage Caps

LLM usage policy reference:

```text
policy://takosumi-cloud/llm-usage/starter-closed-ga
```

Tool usage policy reference:

```text
policy://takosumi-cloud/tool-usage/starter-closed-ga
```

Takosumi Cloud must distinguish hosted platform operations from customer Capsule
execution. LLM and tool usage caps apply to Cloud-only hosted features that
consume operator resources, such as compatibility helpers, review assistants, or
managed service helpers when they are enabled.

Capsule OpenTofu provider execution remains controlled through Provider
Connections, Credential Recipes, Provider Bindings, runner policy, and egress
policy. Generic provider credentials are not operator LLM/tool spend.

### Release Artifact Policy

Policy reference:

```text
policy://takosumi-cloud/release-artifacts/immutability-v1
```

Immutability reference:

```text
artifact-retention://takosumi-cloud/platform-worker/v1
```

Production promotion must keep immutable references for:

- commit SHA
- Cloudflare Worker version id
- dashboard asset digest
- runner image digest or Cloudflare Container smoke reference
- D1 migration transcript when schema changes
- rollback target Worker version id

Mutable labels such as `latest` are not valid rollback targets. This policy
only proves the artifact policy exists. CI-equivalent evidence, SBOM, signature,
image digest, package version, branch protection export, and rollback drill
evidence remain separate launch-readiness requirements.

### Billing Support Runbook

Runbook reference:

```text
runbook://takosumi-cloud/support/billing-closed-ga-v1
```

Owner:

```text
support-owner:takosumi-cloud-operator
```

Billing support covers:

- explaining `disabled`, `showback`, and `enforce` modes;
- locating the customer's Workspace and billing state;
- confirming whether paid enforcement is enabled for the cohort;
- collecting sanitized Stripe or provider event references without exposing
  secrets;
- recording customer-facing support notes;
- escalating suspected payment, entitlement, dunning, refund, or credit issues;
- pausing enforcement for a Workspace only with an audited operator override.

Support responses must not promise refund, credit, deletion, export, or
provider-side resource cleanup until the matching operation has actually run and
evidence has been recorded.

### Security Controls Draft

The security threat model, runner sandbox review, and vulnerability SLA must be
accepted through security-operations evidence before they count as completed.
This launch brief intentionally does not mark those items complete.

Minimum topics for the security review:

- hosted runner isolation and cleanup;
- secret injection only into temporary run sandboxes;
- log redaction;
- provider egress policy;
- operator-only access to upstream Cloud credentials;
- fail-closed Gateway behavior for unsupported provider operations;
- vulnerability intake, triage, patch, and customer notification SLA.

## SKU

The first customer-facing SKU is:

```text
takosumi-cloud-starter
```

This SKU means hosted Takosumi Cloud access with Google sign-in, one default
Workspace, Git URL Capsule install, Provider Connection setup, hosted run
history, state, outputs, and audit evidence.

Until GA, hosted Takosumi Cloud login is restricted in code to the verified
Google account `shoutatomiyama0614@gmail.com` on `app-staging.takosumi.com` and
`app.takosumi.com`. Operator env cannot widen that official Cloud allowlist.

It does not by itself mean paid enforcement, managed Cloud resources, or public
compatibility gateway coverage.

## Quota Plan

Initial quota policy reference:

```text
policy://takosumi-cloud/quota/starter-closed-ga
```

The starter quota must cap at least:

- new Capsule creations per Workspace per day;
- concurrent Runs per Workspace;
- runner wall-clock time per Run;
- retained StateVersions and run logs;
- outbound source fetch and provider egress policy.

The quota plan cannot pass full GA readiness until quota spike, noisy tenant,
kill switch, abuse queue, override, and audit drills are recorded.

## Billing Meter

Billing meter reference:

```text
meter://takosumi-cloud/usd-balance/v1
```

The planned customer-visible units are:

- USD-denominated balance (`usdMicros` in the ledger);
- Cloudflare Compatibility Gateway usage priced by the operator price book;
- AI Gateway usage priced by the operator price book;
- managed resource usage when Cloud-only managed resources are opened.

Billing may remain `disabled` or `showback` for OSS/operator showback while
access is closed. Takosumi Cloud-provided WfP / AI / managed resources are
still spend-required: their usage must be priced by
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`, deducted from Workspace USD balance, and
fail closed when balance is exhausted. Current customer prices and the free
tier are defined in [`cloud-pricing.md`](cloud-pricing.md).

## Support Tier And SLA

Initial support tier:

```text
support-tier://takosumi-cloud/community-plus
```

Initial support SLA reference:

```text
sla://takosumi-cloud/closed-ga-support-v1
```

The target before open access is:

- acknowledgement within 2 business days for normal support;
- best-effort same-day acknowledgement for production sign-in, billing, or data
  export issues;
- incident record and customer support note for customer-impacting incidents.

This support tier is not complete until the support mailbox test, escalation
matrix, billing support runbook, and incident rehearsal evidence pass.

## Free Trial Policy

Free trial policy reference:

```text
policy://takosumi-cloud/free-trial/closed-ga-v1
```

The first trial may include hosted dashboard access, compatibility checks, and a
limited monthly USD grant. Initial free tier is `$0.25 / Workspace / month`,
non-carrying, and bounded by account/workspace abuse controls. It must not
silently open paid billing or unbounded managed resource usage.

## Accepted Use Policy

Accepted use policy reference:

```text
policy://takosumi-cloud/aup/closed-ga-v1
```

Customers must not use Takosumi Cloud for:

- credential exfiltration or scanning targets they do not control;
- evading provider quotas, account limits, or billing controls;
- running Capsules that intentionally bypass Provider Connection policy,
  lockfile policy, egress policy, or runner isolation;
- abusing hosted runner capacity or creating noisy-tenant behavior.

Enforcement must be auditable and recoverable through the suspension, export,
and deletion wording in the customer operations runbook.

## Beta Scope

Beta scope reference:

```text
scope://takosumi-cloud/closed-ga-beta-2026-06
```

Before the access gate opens, Takosumi Cloud remains closed and may be used only
by operator-approved users. A broader GA announcement requires passing every
launch-readiness domain and staged rehearsal step.

## Readiness Mapping

This document backs `domains.offering-definition.evidence.launch-brief`.

It can also back these operator-review policy evidence refs:

- `billing-entitlement.evidence.usage-aggregation-policy`
- `quota-abuse-spend-control.evidence.quota-plan`
- `quota-abuse-spend-control.evidence.spend-cap`
- `quota-abuse-spend-control.evidence.llm-tool-usage-cap`
- `release-provenance.evidence.artifact-policy`
- `legal-privacy-support.evidence.billing-support-runbook`

It does not satisfy `operator-signoff`. Operator signoff must be added as a
separate evidence reference after a human operator accepts the launch scope,
quota, billing, support, AUP, and beta scope.

It also does not satisfy legal signoff, security threat-model acceptance,
sandbox review, vulnerability SLA evidence, Stripe flows, support mailbox
checks, incident drills, restore drills, rollback drills, quota abuse drills, or
any provider/resource operation coverage.
