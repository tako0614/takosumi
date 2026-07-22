# Security Policy

Do not open a public issue with vulnerability details, credentials, tenant
data, or production identifiers.

Report suspected Takosumi vulnerabilities to `security@takos.jp`. Include the
affected component, impact, reproducible steps, and a suggested mitigation when
known. Encrypt sensitive supporting material or request a secure transfer path
before sending it.

## Scope

This policy covers the Takosumi OSS control plane, Accounts/OIDC plane,
dashboard, CLI, reference runner, OpenTofu modules, and operator reference
composition in this repository. Closed Takosumi Cloud implementation and
official managed capacity follow the Cloud operator policy in addition to this
baseline.

Only the current `main` branch and immutable releases still supported by the
operator are eligible for security fixes. Pre-release compatibility surfaces
may change to close a vulnerability.

## Response targets

We triage reports by exploitability and impact. The patch targets are:

| Severity                                  | Target      |
| ----------------------------------------- | ----------- |
| Critical exploited or internet-facing RCE | 24 hours    |
| Critical not known exploited              | 72 hours    |
| High                                      | 7 days      |
| Medium                                    | 30 days     |
| Low                                       | best effort |

Targets begin after a report has enough information to reproduce or bound the
issue. A time-boxed exception must have an owner, compensating control, and
expiry. Operational details are defined in
[`docs/operations/vulnerability-response.md`](docs/operations/vulnerability-response.md).

## Coordinated disclosure

Please allow time for triage, remediation, staging verification, and affected
operator notification before publication. We will acknowledge the report,
communicate material status changes, and coordinate a disclosure date when the
issue is confirmed. Good-faith research that avoids privacy violations,
service disruption, persistence, and data modification is welcome.

Never include live secrets or private keys in a reproduction. Use fixtures and
the smallest affected data set possible.
