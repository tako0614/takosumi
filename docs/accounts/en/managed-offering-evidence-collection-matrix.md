# Managed Offering Evidence Matrix {#managed-offering-evidence-matrix}

This matrix describes how an operator collects evidence for
`takosumi.managed-offering-readiness@v1`. It is a collection guide, not the base Takosumi compatibility
contract.

The canonical workflow is run from `takos-private`: `managed-offering:workspace`, `managed-offering:validate`,
`managed-offering:topology:preflight`, `managed-offering:topology:merge`, `managed-offering:public-summary`,
`managed-offering:public-summary:validate`, and `managed-offering:audit`. Raw evidence stays in the operator-owned
private evidence store.

## Collection Rules

| Rule                             | Requirement                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source system                    | Record the system that actually produced the proof: Accounts route, dashboard, Stripe, telemetry, CI, vault, legal system, support system, or provider API.     |
| Collection command / API / probe | Save command transcripts, HTTP route output, dashboard exports, synthetic probe JSON, or review records as private artifacts.                                   |
| Private artifact/ref             | Use stable refs such as `vault://managed-readiness/<env>/<run>/<type>.json`, `artifact://...`, `r2://...`, `s3://...`, `gs://...`, or `secret-manager://...`.   |
| Structured fields                | Fill the fields emitted by the `launch-readiness template`. Placeholder refs, `example.*`, short summaries, and self-review do not pass.                        |
| Pass criteria                    | Mark only live launch-grade evidence as `status: "passed"`. Dry-run-only records count only where the row explicitly permits dry-run evidence.                  |
| Public redaction                 | Public summaries say what was verified and in which environment. They do not include raw IDs, PII, secrets, provider details, Stripe IDs, or auth-bearing logs. |

Cloudflare Accounts topology evidence treats Accounts as Worker-only. Workers.dev health with `persistence:"d1+r2"` is
bootstrap evidence, not launch topology evidence. DNS/TLS and custom-domain health/OIDC evidence must come from
`takosumi` `deploy:accounts-cloudflare:ensure-dns -- --check --fail-on-not-ready` and
`deploy:accounts-cloudflare:probe -- --fail-on-not-ready` against the public hostname.

## P0 Domain Evidence

| Domain                         | Required evidence types                                                                                                                                                                                | Source and pass criteria                                                                                                                                                                                                                              | Public redaction                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Offering definition            | `launch-brief`, `operator-signoff`                                                                                                                                                                     | Product/operator approval records for SKU, quota, billing meter, support tier, accepted-use scope, and launch owner/reviewer sign-off.                                                                                                                | Publish launch scope status only.                                                          |
| Production topology            | `staging-manifest`, `staging-artifact-digest`, `staging-migration-transcript`, `staging-health-probe`, `staging-tls-evidence`, `staging-rollback-target`, `production-*` equivalents                   | Run staging and production topology preflight, then merge. Include immutable artifact digests, rollback target, live DNS/TLS/custom-domain health/OIDC proof, Accounts Worker D1/R2 bindings, rendered config validation, and provider evidence refs. | Publish environment, component count, probe count, and pass/fail only.                     |
| OIDC/account security          | `oidc-conformance`, `key-rotation-drill`, `client-secret-rotation`, `passkey-e2e`, `rate-limit-test`, `audit-event`                                                                                    | Prove authorize/token/userinfo, signing-key rotation, client-secret rotation with overlap/revocation, passkey flow, rate limit, and audit trail.                                                                                                      | Do not publish client secrets or identifiable client IDs.                                  |
| Signup and tenant lifecycle    | `fresh-user-smoke`, `email-assurance`, `team-membership`, `launch-token-consume`, `bundled-app-install`, `terms-acceptance`, `suspend-recover`                                                         | Fresh user reaches account, Space, terms, entitlement, Use Takos, bundled app lifecycle, suspend, and recover.                                                                                                                                        | No account, email, team, token, session, or installation IDs.                              |
| Billing and entitlement        | `stripe-sandbox`, `stripe-live`, `entitlement`, `usage-meter`, `usage-aggregation-policy`, `invoice`, `tax-policy`, `plan-transition`, `failed-payment`, `dunning`, `refund-credit`, `suspend-recover` | Stripe sandbox/live checkout and webhook paths produce expected entitlement, invoice, failed payment, dunning, refund/credit, and account state changes.                                                                                              | Do not publish Stripe object IDs, prices, customer IDs, invoice IDs, tax detail, or email. |
| Quota / abuse / spend control  | `quota-plan`, `spend-cap`, `llm-tool-usage-cap`, `quota-spike-drill`, `noisy-tenant-throttle`, `deploy-kill-switch`, `abuse-queue-review`, `operator-override`, `audit-event`                          | Quota, spend, LLM/tool usage, noisy tenant, runaway deploy, abuse review, override, and audit paths work.                                                                                                                                             | Publish guard result only.                                                                 |
| Shared-cell runtime            | `load-test`, `isolation-test`, `metric-labels`, `scale-drain-event`, `evacuation-record`                                                                                                               | At least two tenants share one runtime cell while isolation, per-installation metrics, scale/drain, and evacuation evidence pass.                                                                                                                     | No tenant IDs or usage payloads.                                                           |
| Dedicated materialize          | `readiness-probe`, `cutover`, `rollback-before-final`, `domain-preservation`, `oidc-preservation`, `data-partition-preservation`, `permission-scope-preservation`, `no-data-loss-check`                | Dedicated runtime cutover and rollback preserve identity, OIDC client, domain, data partition, permission scope, and no-data-loss checks.                                                                                                             | No raw domain/user data unless already public.                                             |
| Export / self-host sovereignty | `encrypted-export`, `clean-import`, `post-import-login`, `sample-data-verification`, `source-retention-state`                                                                                          | Export/import covers chat, memory, file, git, and default-app data classes with target OIDC rewrite and post-import login.                                                                                                                            | No archive links or user content.                                                          |
| Backup / DR                    | `restore-transcript`, `restore-target-smoke`, `audit-chain-verification`, `rpo-rto-sample`, `dr-simulation`                                                                                            | Isolated restore, audit chain verification, RPO/RTO sample, and DR simulation pass.                                                                                                                                                                   | Publish RPO/RTO class and pass/fail only.                                                  |
| Observability / SLO / on-call  | `dashboard-link`, `alert-routing`, `synthetic-probe`, `sev-drill`, `status-update`                                                                                                                     | Dashboard, alert routing, signup/login/install/launch/export synthetic probe, SEV drill, status update, and postmortem are linked.                                                                                                                    | No private support content.                                                                |
| Release provenance             | `ci-equivalent`, `sbom`, `signature`, `image-digest`, `package-version`, `branch-protection-export`, `artifact-policy`, `rollback-drill`                                                               | Release artifact is immutable, signed, versioned, policy-covered, and rollback-tested.                                                                                                                                                                | Publish digest/signature presence, not private runner logs.                                |
| Security operations            | `threat-model`, `sandbox-review`, `vulnerability-sla`, `secret-inventory`, `secret-rotation-run-log`, `security-contact`, `installer-abuse-blocked`                                                    | Security owner and reviewer confirm threat model, sandbox decision, SLA, inventory, rotation, contact test, and abuse block.                                                                                                                          | Publish owner-reviewed status only.                                                        |
| Legal / privacy / support      | `legal-signoff`, `public-legal-pages`, `support-mailbox-test`, `sar-delete-rehearsal`, `billing-support-runbook`                                                                                       | Legal, privacy, support, SAR, retention, and billing support paths are approved.                                                                                                                                                                      | Publish page availability and rehearsal status only.                                       |
| Customer operations            | `onboarding-guide`, `admin-guide`, `billing-faq`, `export-guide`, `escalation-matrix`, `suspension-delete-export-wording`                                                                              | Customer-facing guides and escalation matrix are reviewed and versioned.                                                                                                                                                                              | Publish document categories only.                                                          |

## Staged Rehearsal Evidence

All staged rows must share one `rehearsalRun.id`, one environment, and strictly increasing `completedAt` values.

| Step                      | Required evidence types                                                                                                | Pass criteria                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Fresh signup              | `signup-event`, `email-assurance`, `team-membership`, `terms-acceptance`, `entitlement-event`                          | Fresh account and Space are created with terms and entitlement.       |
| Use Takos launch          | `launch-token-consume`, `bundled-app-install`, `default-app-uninstall`, `default-app-reinstall`                        | Use Takos reaches a Takos session and default app lifecycle works.    |
| Git URL install           | `installation-dry-run`, `cost-review`, `install-apply`, `oidc-login`, `event-hash-chain`                               | Dry-run, apply, login, and event hash chain are verified.             |
| Quota / abuse drill       | `quota-exceeded`, `guard-action`, `override-audit`                                                                     | Guard action and override audit are recorded.                         |
| Shared-cell load          | `two-tenant-load`, `isolation-proof`, `per-installation-metrics`, `scale-or-drain`                                     | Two tenants share a cell and isolation passes.                        |
| Dedicated materialize     | `readiness-before-cutover`, `materialize-cutover`, `rollback-before-final`, `domain-preservation`, `preserve-evidence` | Cutover and rollback preserve access and data.                        |
| Export / self-host import | `encrypted-export`, `clean-import`, `post-import-login`, `sample-data-verification`, `source-retention-state`          | Clean import validates chat, memory, file, git, and default-app data. |
| Backup restore            | `restore-transcript`, `restore-target-smoke`, `audit-chain-verification`, `rpo-rto-sample`                             | Restore target smoke and audit-chain verification pass.               |
| SEV simulation            | `alert`, `ack`, `status-update`, `postmortem`                                                                          | Full incident workflow is recorded.                                   |
| Release rollback          | `release-promotion`, `rollback`, `support-note`                                                                        | Rollback restores a healthy deployment and support note is recorded.  |
| Privacy operation         | `export-or-delete-request`, `login-disabled-or-exported`, `retention-record`                                           | Privacy operation reaches expected state and owner review.            |
| Billing operation         | `invoice-paid`, `failed-payment`, `dunning-suspension`, `recovery-refund-credit`                                       | Billing failure and recovery path are auditable.                      |

## Launch Opening Audit

After the private bundle and public summary are generated, run the `takos-private` audit wrapper:

```bash
cd ../takos-private
bun run managed-offering:audit -- \
  --environment <staging|production> \
  --date <YYYY-MM-DD> \
  --evidence-ref <private evidence ref> \
  --approval-ref <separate approval ref>
```

The wrapper validates the private bundle and public summary, dry-runs open managed access with the same canonical
digest, private evidence ref, approval ref, and public summary, and emits `accountsServeManagedOfferingArgs` for the
real Accounts service command.
