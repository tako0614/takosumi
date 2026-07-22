# Published Docs Contract

This page defines what `takosumi.com/docs` publishes as software docs.
Published docs contain only the external contract that users and self-host /
operator readers can rely on. Hosted Cloud service docs live separately at
`app.takosumi.com/docs`.

## What Published Docs Include

Published docs include:

- Takosumi / Takosumi for Operator / Takosumi Cloud definitions and edition boundaries
- Quickstart, Git URL install, OpenTofu Stack flow, and Resource Shape flow usage
- API endpoints, request / response shapes, authentication, and error shapes
- Resource Shape, Compatibility API, ProviderConnection, CredentialRecipe, and ProviderBinding specs
- supported / preview / planned / unsupported compatibility matrices
- external pointers to the Takosumi Cloud hosted docs
- security contracts such as no secret redisplay, no secret logs, and run-scoped secret injection

Required public contract information must not depend on unpublished notes.

## Software Docs / Hosted Cloud Docs Split

Published docs use separate sites. `takosumi.com/docs` is for software and
Operator docs. `app.takosumi.com/docs` is for the hosted Cloud service.

| Surface                                     | Subject                              | Include                                                                                                                                            | Exclude                                                                                                   |
| ------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Software docs (`takosumi.com/docs`)         | Takosumi OSS / Takosumi for Operator | portable APIs, OpenTofu Stack flow, Resource Shape flow, ProviderConnection, Run ledger, behavior that works on self-hosted and operator endpoints | `app.takosumi.com` pricing, official managed-resource usage, day-to-day Cloud API key operations          |
| Hosted Cloud docs (`app.takosumi.com/docs`) | Takosumi Cloud                       | official hosted service, managed resources, Cloud endpoint families, pricing, spend guard, Cloud API keys, usage                                   | wording that makes Cloud-only features required Takosumi core behavior or implies every endpoint has them |
| Operator docs / runbooks                    | operator                             | deployment, secret rotation, evidence, private operational procedures                                                                              | substitutes for public contract docs                                                                      |

When software docs mention Cloud, keep it to definitions and pointers. When
Cloud docs mention the software model, use it only to explain that Cloud is a
hosted deployment of the same Takosumi model.

## Published Pages Must Be Self-Contained

Published pages must include enough information for readers to make decisions
without reading internal notes or operator runbooks.

| Topic                       | Published docs must include                                              | Keep internal                                         |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| product / edition boundary  | external Takosumi, Takosumi for Operator, and Takosumi Cloud definitions | design alternatives and unsettled roadmap notes       |
| API / compatibility surface | endpoint, capability, auth, errors, supported/preview/unsupported        | handler wiring, closed repo paths, and private routes |
| Resource Shape              | schema, lifecycle, state/import/drift behavior                           | adapter internals and private target inventory        |
| Cloud pricing / billing     | customer prices, onboarding credit, spend guard, auto charge behavior    | price IDs, cost tables, margin guards, reconciliation |
| security / secret handling  | no secret redisplay, log redaction, run-scoped injection                 | secret file paths, vault paths, and operator tokens   |

Published pages must not link to `docs/internal/` or `docs/operations/` as a
substitute for explaining the contract. If an internal note becomes public, the
stable public-safe contract is rewritten into this docs tree.

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

Published pricing pages live in the hosted Cloud docs at
`app.takosumi.com/docs`. They include:

```text
customer pays
onboarding credit
usage prices
spend guard behavior
auto charge behavior
refund / cancellation surface
```

Published software docs and hosted Cloud docs exclude:

```text
payment provider price id
realized versioned PriceCatalog storage
cost estimate spreadsheet
margin guard implementation
invoice export or reconciliation procedure
```

Public prices are customer-facing contracts. Operational sync, costs, and
reconciliation belong to operator runbooks.
