# Managed Offering 顧客境界 (Draft)

> Draft only. This page is not launch evidence and does not mean public signup, billing, or support is open.

This page captures the current customer-facing boundary for offering Takos as a managed service through a `takosumi` operator 実装. The final public wording still requires operator, support, billing, security, and legal review, and the launch gate remains `takos-private managed-offering:validate` plus the final live audit.

## Scope

Takos is the customer product: AI-first chat, agent, memory, and space workflows, with first-party apps installed into new spaces as normal Takosumi Installations. Takosumi is the platform substrate. `takosumi` is the operator のアカウント管理 for this managed offering: identity, billing, ownership ledger, dashboard, launch tokens, and export/import operations.

The managed offering draft is limited to a beta public service operated by one operator アカウント管理 instance. It does not claim that every Takosumi-compatible operator の設定 has been verified, and it does not replace the self-host export path.

## Launch Brief Fields

The private `offering-definition` evidence record should map these fields before public signup opens:

| Field                 | Current draft requirement                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Target customer       | Small teams or individuals that want hosted Takos without operating Takosumi infrastructure                       |
| Launch scope          | Takos chat / agent / memory / space plus bundled first-party apps and Git URL app installation                    |
| Beta boundary         | Managed runtime, quotas, support response, export/import, and billing are beta until the staged rehearsal passes  |
| SKU                   | Free or paid plan names must map to quota, billing meter, support tier, and export rights                         |
| Billing meter         | Meter definition must match Accounts billing usage records and invoice policy                                     |
| Quota                 | Per-plan caps must cover storage, app installs, agent/tool/LLM usage, shared-cell capacity, and export operations |
| Support tier          | Support response targets, escalation path, and security contact must be written before opening signup             |
| Accepted-use boundary | Abuse, prohibited automation, tenant isolation, and suspension policy must be reviewable by support               |
| Free trial            | Trial length, conversion, downgrade, deletion, and export rights must be explicit                                 |

## Customer Operations Draft

The private `customer-operations` evidence record should prove that the public customer docs and dashboard links cover these workflows:

| Workflow           | Required customer wording                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Onboarding         | Signup, terms acceptance, Space creation, Use Takos launch, bundled app install, and first admin action                      |
| Admin guide        | Space/team membership, app install/uninstall, installation status, app permissions/grants, and account session ownership     |
| Billing FAQ        | Plan selection, invoice lifecycle, failed payment, dunning/suspension, recovery, refunds/credits, and usage meter visibility |
| Quota and abuse    | What happens when usage exceeds plan limits, how throttling/blocking/suspension appears, and how override review works       |
| Export / self-host | How to request export, what data classes are included, download expiry, import boundary, and source account retention state  |
| Privacy operations | Export/delete request path, retention exceptions, login disablement, and expected customer-visible state                     |
| Incident status    | Where status updates appear, what customer updates include, and when support escalates                                       |
| Support escalation | Support mailbox/ticket path, security disclosure path, billing support path, and response expectations                       |

## Evidence Boundary

Draft docs are not enough to open managed access. The launch bundle must still include accepted private refs for:

- `offering-definition` with operator sign-off for launch scope, SKU, quota, meter, support tier, accepted-use boundary, beta label, and free-trial policy
- `customer-operations` with support owner review of onboarding, admin, billing, export/self-host, incident, suspension/delete/export, and escalation wording
- one staged launch rehearsal proving fresh signup, Use Takos, Git URL install, quota/abuse handling, shared-cell load, dedicated materialize, export/import, backup/restore, SEV simulation, release rollback, privacy operation, and billing operation

Public summaries may say these materials were reviewed only after `managed-offering:validate`, `managed-offering:public-summary:validate`, and `managed-offering:audit` all pass against the same evidence digest.
