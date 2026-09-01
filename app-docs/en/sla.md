# Takosumi Cloud SLA

> **Historical archive — not current authority.** This page records the retired
> Takosumi Cloud plan/implementation. It is not current availability, pricing,
> SLA, support, or production authority. Takosumi Hosted owns new
> retail/commerce/client-composition documentation; Takoserver owns managed
> supply, capacity, provider credentials, and Offerings. Preserve the body as
> historical evidence and do not use it as current service authority.

This page defines Takosumi Cloud availability targets and public incident
communications. Until the public-access gate opens, these are the operating
targets for GA. `sla://takosumi-cloud/official-sla-v1` takes effect when that
gate opens.

## Monthly availability targets

| Scope | Target |
| --- | ---: |
| Control-plane API, sign-in, Dashboard, and Run submission and reads | 99.9% |
| Official Cloud capacity offered as Stable | 99.9% |
| AI Gateway, excluding upstream models | 99.5% |

Availability is measured by UTC calendar month. It counts 5xx responses caused
by Takosumi Cloud and failures of the five-minute production synthetic probe.
Customer-code errors, 4xx responses, customer-configured budgets, spend guards,
AUP enforcement, and failures of external providers are not Takosumi Cloud
downtime.

The AI Gateway target covers the Takosumi Cloud gateway. It does not include
availability of the selected AI model or upstream API.

## Planned maintenance

We normally announce planned maintenance that can affect availability at least
48 hours in advance on
[status.takosumi.com](https://status.takosumi.com/). Announced maintenance
windows are excluded from monthly availability.

Urgent security or data-protection work can take precedence over advance
notice. In that case we publish an update as soon as practical after work
starts.

## Incident communications

[status.takosumi.com](https://status.takosumi.com/) is the authoritative public
service-status page.

| Severity | Initial-update target | Continuing updates |
| --- | --- | --- |
| SEV-1: broad outage or material data or security impact | Within 60 minutes of detection | Normally every 60 minutes |
| SEV-2: material impact to a feature or subset of customers | Within 4 hours of detection | Normally twice per day |
| SEV-3: limited impact | When useful | As needed |

After a SEV-1 incident, we publish a safe summary of cause and corrective
actions. Public updates never include customer Workspace or Resource
identifiers, provider object identifiers, secrets, or raw logs.

## Support response

See [Support](./support.md) for the official channel and request scope.

- General requests: acknowledgement within two business days.
- Production sign-in, billing, or data-export incidents: acknowledgement within
  one business day.
- Business hours: Monday through Friday, 09:00–18:00 JST, excluding Japanese
  public holidays.

These are acknowledgement and communication targets. Resolution time is not
fixed because it depends on the incident and external-provider involvement.

## Service credits

This SLA publishes availability and communication targets. Falling below a
target does not create a monetary refund, fee reduction, or automatic service
credit. We investigate incorrect or duplicate charges through the ordinary
billing-support process rather than as SLA credits.

## Exclusions

This SLA applies only to the official hosted Takosumi Cloud service. It does
not apply to Takosumi OSS, self-hosted environments, customer Provider
Connections, customer code, or features explicitly marked preview or
experimental.
