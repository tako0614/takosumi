# Operations: On-call and SEV Policy

> このページでわかること: Takosumi operated environments の on-call
> rotation、SEV 分類、paging path、escalation matrix、staging SEV-1
> simulation の実施基準。

この runbook は Takosumi platform worker の運用正本です。対象は
`app.takosumi.com` で動く accounts plane、control plane、dashboard SPA、
Queue、CoordinationObject、OpenTofuRunnerObject、Runner Container、D1/R2
ledger です。Takos product runtime / bundled app runtime の incident は各
product docs が所有します。

## Scope

対象:

- login / session / OIDC issuer
- Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe /
  ProviderBinding / Secret / Run / StateVersion / Output / AuditEvent APIs
- ProviderConnection / CredentialRecipe APIs and policy gates
- ProviderBinding resolution and custom runner policy
- source snapshot / compatibility check / plan / apply / destroy flow
- runner queue and container execution
- StateVersion / Output / artifact / backup storage
- Workspace quota / showback ledger
- dashboard and AuditEvent views

Takosumi CLI / internal operator scripts are support tooling only and are not
the incident command surface.

## Roles

| Role                 | Owner                        | Responsibility                                        |
| -------------------- | ---------------------------- | ----------------------------------------------------- |
| Primary on-call      | current rotation owner       | alert ack, first triage, mitigation owner             |
| Secondary on-call    | next rotation owner          | backup ack, parallel investigation, rollback approval |
| Incident commander   | primary or assigned operator | SEV declaration, war room, timeline, decision log     |
| Communications owner | support / product owner      | customer update, status page, support sweep           |
| Subject-matter owner | service owner                | deep dive, fix owner, postmortem action owner         |

Primary and secondary should not share the same timezone / failure domain when
possible. Active SEV-1 handoff requires synchronous acknowledgement in the
incident channel.

## SEV Classification

| SEV   | Customer impact                                                                                           | Examples                                                                                                                                                                                                                        | Ack target      | Update cadence              |
| ----- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------- |
| SEV-1 | production-wide outage, data loss risk, security-critical exposure, deploy/auth/source access unavailable | platform worker 5xx, OIDC issuer unavailable, cross-Workspace data exposure, known secret leak, state/artifact corruption                                                                                                       | 5 min           | 15 min                      |
| SEV-2 | major feature degradation, multiple Workspaces affected, workaround exists                                | plan/apply mostly failing, queue backlog, runner container startup failures, quota/showback write failure, ProviderConnection / CredentialRecipe outage, secret-backed provider mint failure, provider egress policy regression | 15 min          | 30 min                      |
| SEV-3 | isolated Workspace / non-critical degradation, operational toil                                           | single Capsule Run failure, dashboard drift, slow backup job, docs/runbook issue                                                                                                                                                | 1 business hour | daily or on material change |

When scope is unclear, start at SEV-2 or higher. Suspected customer data
exposure is SEV-1 until disproven.

## Paging Path

1. Alert fires from Takosumi monitoring: HTTP 5xx / latency, deploy success
   rate, runner queue age, D1/R2 health, quota/showback ledger drift, secret rotation
   failure.
2. Paging provider routes to primary on-call.
3. Primary acknowledges within target and opens incident channel.
4. If primary does not ack, page secondary after 5 minutes and incident
   commander backup / product owner after 10 more minutes.
5. SEV-1 / SEV-2 gets an incident record and customer communication decision.

## Escalation Matrix

| Trigger                              | Primary action                         | Escalate to secondary                     | Escalate to owner               | Escalate to product / legal |
| ------------------------------------ | -------------------------------------- | ----------------------------------------- | ------------------------------- | --------------------------- |
| SEV-1 declared                       | immediate page + war room              | immediately                               | immediately for affected area   | within 15 min               |
| SEV-2 declared                       | page primary                           | no ack after 15 min or unclear mitigation | no mitigation path after 30 min | customer update needed      |
| Security / secret exposure suspected | freeze affected path                   | immediately                               | security owner immediately      | immediately                 |
| State / output integrity risk        | stop writes if safe, preserve evidence | immediately                               | storage / control-plane owner   | within 15 min               |
| Failed platform rollback             | start rollback SOP                     | rollback blocked after 15 min             | release owner                   | if customer impact persists |
| Runner backlog                       | throttle new runs / drain queue        | no improvement after 30 min               | runner owner                    | if deploy SLA breached      |

## Incident Command Procedure

1. Declare SEV and appoint incident commander.
2. Open war room with `#inc-<date>-<slug>` naming and pin impact, affected
   surfaces, mitigation owner, next update time.
3. Freeze non-essential platform deploys and optionally pause new plan/apply
   dispatch for affected Workspaces.
4. Capture timeline events for alerts, ack, mitigation attempts, rollback,
   customer updates, recovery signals.
5. Prefer reversible mitigation: rollback platform worker version, pause queue,
   throttle applies, disable an integration, rotate/revoke leaked credential.
6. Resolve only after two observation windows are green and no new customer
   impact is reported.

## SEV-1 Staging Simulation

hosted Takosumi launch readiness requires at least one SEV-1 simulation in
staging. The simulation must not page customers.

Required scenario:

1. Pick a staging-only failure injection:
   - block platform worker health route,
   - force plan/apply dispatch failure,
   - stop runner container startup,
   - or inject a D1 read-only / lock error.
2. Confirm alert fires and routes to primary on-call.
3. Primary acknowledges within 5 minutes.
4. Incident commander opens a staging incident channel and records timeline.
5. Execute mitigation or rollback and confirm recovery signal.
6. Write simulation record with date, injected failure, alert id, ack latency,
   mitigation action, recovery time, and follow-up actions.

Evidence lives in the operator's private run log or approved incident system.
Public docs must not contain secret names, provider account ids, customer
identifiers, or private incident links.

## Postmortem Requirement

SEV-1 always requires a postmortem. SEV-2 requires one when customer impact
lasts more than 30 minutes, rollback fails, data integrity is involved, or
manual operator action was the only mitigation.

Postmortem must include customer impact, exact timeline, root cause,
contributing factors, detection gap, mitigation / recovery actions, action
items with owner and due date, and classification review.
