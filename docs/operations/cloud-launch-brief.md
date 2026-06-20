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

- arbitrary managed Cloud resources without explicit coverage;
- Cloudflare Compatibility Gateway public availability unless its provider and
  resource operation coverage has separate readiness evidence;
- GitHub OAuth as a sign-in provider;
- CLI-first onboarding for hosted customers;
- paid enforcement before Stripe, entitlement, invoice, dunning, refund, and
  support drills pass readiness.

## SKU

The first customer-facing SKU is:

```text
takosumi-cloud-starter
```

This SKU means hosted Takosumi Cloud access with Google sign-in, one default
Workspace, Git URL Capsule install, Provider Connection setup, hosted run
history, state, outputs, and audit evidence.

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
meter://takosumi-cloud/credits/v1
```

The planned customer-visible units are:

- runner minutes;
- compatibility checks;
- plan/apply/destroy runs;
- stored state/log/artifact size;
- managed resource units when Cloud-only managed resources are opened.

Billing may remain `disabled` or `showback` while access is closed. `enforce`
requires Stripe and entitlement readiness evidence.

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
limited number of plan/apply Runs. It must not silently open paid billing or
unbounded managed resource usage.

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

It does not satisfy `operator-signoff`. Operator signoff must be added as a
separate evidence reference after a human operator accepts the launch scope,
quota, billing, support, AUP, and beta scope.
