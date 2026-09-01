# Resources and providers

> **Historical archive — not current authority.** This page records the retired
> Takosumi Cloud plan/implementation. It is not current availability, pricing,
> SLA, support, or production authority. Takosumi Hosted owns new
> retail/commerce/client-composition documentation; Takoserver owns managed
> supply, capacity, provider credentials, and Offerings. Preserve the body as
> historical evidence and do not use it as current service authority.

A Git repository's OpenTofu module declares the cloud resources used with
Takosumi Cloud. The selected provider creates them. Takosumi supplies the Run
and state boundary; it does not replace the provider.

## Provider choices

The module's `required_providers` is authoritative. A Workspace can use:

- a user's Cloudflare, AWS, or another cloud account;
- a self-hosted or third-party provider endpoint; or
- the Takosumi Cloud Takoform Host after it is released.

Takosumi Cloud does not infer accounts, regions, secrets, or prices from a
provider name. Create a Connection and bind it to the module's provider
requirement. Credentials are materialized only inside the runner for the Run;
they are not written to plan displays, outputs, Interfaces, or logs.

## Lifecycle

```text
repository commit
  → provider requirements and variables
  → reviewed OpenTofu plan
  → provider apply
  → versioned state and Output
```

Updates and deletion use the same graph. A Dashboard action or data endpoint
does not create a second copy of the object. If a provider fails, the Run keeps
the diagnostic and fails closed instead of silently choosing another backend.

## Cloud catalog

Authenticated `GET /v1/cloud/catalog` returns hosted services, prices,
protocols, and availability for the current Workspace. The catalog is for
discovery and presentation. It is not the authority for OpenTofu state or the
provider graph.

These facts are checked independently:

- the provider or protocol is released;
- the Cloud backend and capacity are configured;
- the commercial offering is enabled; and
- the Workspace has enough credit, quota, and permission.

If any check fails, execution stops before a provider or billing backend call.

## Outputs and Interfaces

Typed provider outputs are recorded with the Run and state. Connection
information used by an app can be projected into a generic Interface.

An Interface describes an endpoint or protocol document. InterfaceBinding
decides who may use it. Do not put bearer tokens, private keys, or provider
credentials in public outputs or Interface documents. Use the returned
endpoint instead of guessing a hostname.

## Takoform availability

Takoform owns the portable contract and OpenTofu/Terraform provider. Takosumi
Cloud intends to provide the official Host, but an unpublished candidate is
never marked available in the catalog. Availability requires an exact released
contract, production adapter, billing and recovery, and staging evidence.

Unsupported compute families such as VMs are not inferred. The authenticated
catalog, rather than a hard-coded resource list, is the current truth.

## Billing and deletion

Paid operations check the quote, credit, and spend limit before execution.
Usage records both the source Workspace and the paying owner. See
[Pricing](./pricing.md).

Delete existing objects through the same provider graph that created them.
Insufficient credit must not make cleanup impossible, and an ambiguous backend
outcome is never reported as success.
