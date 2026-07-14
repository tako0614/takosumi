# Operations: On-call and SEV Policy

> このページでわかること: Takosumi operated environments の on-call
> rotation、SEV 分類、paging path、escalation matrix、staging SEV-1
> simulation の実施基準。

この runbook は operator が構成した Takosumi platform の汎用運用正本です。
対象は accounts plane、control plane、dashboard SPA、Run queue、coordination、
runner substrate、operator が選択した database / object storage です。公式 hosted
deployment 固有の topology、provider、official SLA/support は host extension の
readiness contribution と runbook が所有します。
Takos product runtime / installable app runtime の incident は各 product docs が
所有します。

## Scope

対象:

- login / session / OIDC issuer
- Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe /
  ProviderBinding / Secret / Run / StateVersion / Output / AuditEvent APIs
- ProviderConnection / CredentialRecipe APIs and policy gates
- ProviderBinding resolution and operator-defined executor policy
- source snapshot / compatibility check / plan / apply / destroy flow
- runner queue and operator-selected execution substrate
- StateVersion / Output / artifact / backup storage
- Workspace quota / showback ledger
- dashboard and AuditEvent views

Takosumi CLI / internal operator scripts are operator utilities only and are not
the incident command surface.

## Roles

| Role                 | Owner                        | Responsibility                                        |
| -------------------- | ---------------------------- | ----------------------------------------------------- |
| Primary on-call      | current rotation owner       | alert ack, first triage, mitigation owner             |
| Secondary on-call    | next rotation owner          | backup ack, parallel investigation, rollback approval |
| Incident commander   | primary or assigned operator | SEV declaration, war room, timeline, decision log     |
| Communications owner | operator-assigned owner      | affected-user update and incident-channel publication |
| Subject-matter owner | service owner                | deep dive, fix owner, postmortem action owner         |

Primary and secondary should not share the same timezone / failure domain when
possible. Active SEV-1 handoff requires synchronous acknowledgement in the
incident channel.

## SEV Classification

| SEV   | User/tenant impact                                                                                         | Examples                                                                                                                                                                                                           | Ack/update policy                |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| SEV-1 | environment-wide outage, data loss risk, security-critical exposure, deploy/auth/source access unavailable | platform service 5xx, OIDC issuer unavailable, cross-Workspace data exposure, known secret leak, state/artifact corruption                                                                                         | operator-configured SEV-1 policy |
| SEV-2 | major feature degradation, multiple Workspaces affected, workaround exists                                 | plan/apply mostly failing, queue backlog, runner startup failures, quota/showback write failure, ProviderConnection / CredentialRecipe outage, provider credential mint failure, provider egress policy regression | operator-configured SEV-2 policy |
| SEV-3 | isolated Workspace / non-critical degradation, operational toil                                            | single Capsule Run failure, dashboard drift, slow backup job, docs/runbook issue                                                                                                                                   | operator-configured SEV-3 policy |

When scope is unclear, start at SEV-2 or higher. Suspected tenant data
exposure is SEV-1 until disproven.

## Paging Path

1. Alert fires from Takosumi monitoring: HTTP 5xx / latency, deploy success
   rate, runner queue age, persistence health, quota/showback ledger drift, secret rotation
   failure.
2. Paging provider routes to primary on-call.
3. Primary acknowledges within target and opens incident channel.
4. If primary does not ack within the configured target, page secondary and
   then the configured incident-commander backup according to the escalation policy.
5. SEV-1 / SEV-2 gets an incident record and affected-user communication decision.

## Escalation Matrix

| Trigger                              | Primary action                         | Escalate to secondary               | Escalate to owner               | Communications/legal decision        |
| ------------------------------------ | -------------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------------ |
| SEV-1 declared                       | immediate page + war room              | configured SEV-1 threshold          | immediately for affected area   | follow configured incident policy    |
| SEV-2 declared                       | page primary                           | configured SEV-2 ack threshold      | configured mitigation threshold | decide based on affected-user impact |
| Security / secret exposure suspected | freeze affected path                   | immediately                         | security owner immediately      | immediately                          |
| State / output integrity risk        | stop writes if safe, preserve evidence | configured integrity-risk threshold | storage / control-plane owner   | follow configured incident policy    |
| Failed platform rollback             | start rollback SOP                     | configured rollback threshold       | release owner                   | if affected-user impact persists     |
| Runner backlog                       | throttle new runs / drain queue        | configured queue/SLO threshold      | runner owner                    | if configured SLO is breached        |

## Incident Command Procedure

1. Declare SEV and appoint incident commander.
2. Open war room with `#inc-<date>-<slug>` naming and pin impact, affected
   surfaces, mitigation owner, next update time.
3. Freeze non-essential platform deploys and optionally pause new plan/apply
   dispatch for affected Workspaces.
4. Capture timeline events for alerts, ack, mitigation attempts, rollback,
   affected-user updates, recovery signals.
5. Prefer reversible mitigation: rollback platform version, pause queue,
   throttle applies, disable an integration, rotate/revoke leaked credential.
6. Resolve only after the configured observation window is green and no new user
   impact is reported.

## SEV-1 Staging Simulation

Operator platform readiness requires at least one SEV-1 simulation in staging.
The simulation must not page real users.

Required scenario:

1. Pick a staging-only failure injection:
   - block platform worker health route,
   - force plan/apply dispatch failure,
   - stop startup on the selected Runner adapter,
   - or inject a configured database read-only / lock error.
2. Confirm alert fires and routes to primary on-call.
3. Primary acknowledges within the operator-configured SEV-1 target.
4. Incident commander opens a staging incident channel and records timeline.
5. Execute mitigation or rollback and confirm recovery signal.
6. Write simulation record with date, injected failure, alert id, ack latency,
   mitigation action, recovery time, and follow-up actions.

Evidence lives in the operator's private run log or approved incident system.
Public docs must not contain secret names, provider account ids, user/tenant
identifiers, or private incident links.

## Postmortem Requirement

SEV-1 always requires a postmortem. SEV-2 requires one when affected-user impact
exceeds the configured threshold, rollback fails, data integrity is involved, or
manual operator action was the only mitigation.

Postmortem must include user/tenant impact, exact timeline, root cause,
contributing factors, detection gap, mitigation / recovery actions, action
items with owner and due date, and classification review.
