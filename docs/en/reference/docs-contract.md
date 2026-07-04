# Published Docs Contract

This page defines what `takosumi.com/docs` publishes. Published docs contain
only the external contract that users, self-host operators, and Takosumi Cloud
customers can rely on.

## What Published Docs Include

Published docs include:

- Takosumi / Takosumi for Operator / Takosumi Cloud definitions and edition boundaries
- Quickstart, Git URL install, OpenTofu Stack flow, and Resource Shape flow usage
- API endpoints, request / response shapes, authentication, and error shapes
- Resource Shape, Compatibility API, ProviderConnection, CredentialRecipe, and ProviderBinding specs
- supported / preview / planned / unsupported compatibility matrices
- Takosumi Cloud public prices, free tier, credit consumption, and fail-closed behavior when credits run out
- security contracts such as no secret redisplay, no secret logs, and run-scoped secret injection

Required public contract information must not depend on unpublished notes.

## What Published Docs Exclude

Published docs do not include:

- production / staging deployment procedures
- secret rotation, operator tokens, vault paths, or local secret file paths
- raw readiness records, smoke transcripts, or incident drill transcripts
- concrete payment provider price IDs, sync procedures, margin guards, or reconciliation procedures
- closed implementation file paths, handler wiring, or private resource IDs
- operator-only support / abuse / evidence collection procedures

Those details are operator runbook or private evidence material, not public
product contracts.

## Promoting A Memo To Public Contract

When a private note becomes necessary for user or operator decisions, do not
link public readers to the private note. Rewrite only the stable contract into
published docs.

Remove:

- private paths
- secret or token names and storage locations
- raw evidence refs
- closed implementation file names
- handler wiring and deploy procedure details
- payment provider sync implementation details

Keep only stable external API, capability, price, security, and failure
behavior.

## Contradiction Rule

When published docs conflict, the more specific reference wins.

```text
API / pricing / legal reference
  > Cloud / Resource reference
  > Quickstart
  > overview
```

Internal notes and operator runbooks do not override the published contract. If
a note changes the external contract, update the matching published page in the
same change.

## Pricing Split

Published pricing pages include:

```text
customer pays
free tier
included credits
usage prices
credit exhaustion behavior
auto charge behavior
refund / cancellation surface
```

Published docs exclude:

```text
payment provider price id
runtime price book storage
cost estimate spreadsheet
margin guard implementation
invoice export or reconciliation procedure
```

Public prices are customer-facing contracts. Operational sync, costs, and
reconciliation belong to operator runbooks.
