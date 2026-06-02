# Managed Offering Launch Readiness {#managed-offering-launch-readiness}

This page explains what an operator must prove before opening a public managed Takos offering through `takosumi`.
It is not the Takosumi base compatibility contract, and it is not evidence that public signup is open.

Takosumi remains the Source / Installation / Deployment substrate. `takosumi` is the replaceable operator
account plane that owns accounts, OIDC, billing, dashboard, install UI, launch tokens, and the account-facing deployment
facade. The managed offering gate is an operator launch gate layered on top of that distribution.

## Evidence Rules

- Keep raw evidence outside public source control. Private records may contain tenant data, provider account IDs, Stripe
  IDs, legal material, support mailbox content, or secrets.
- Public docs may contain only sanitized status, evidence scheme classes, validator results, and non-sensitive summaries.
- Screenshots are supporting evidence. Prefer command transcripts, immutable artifact digests, event IDs, dashboard
  exports, probe JSON, and review records as primary evidence.
- Local green checks and dry-runs are release readiness. They are not public managed-offering launch evidence unless a
  row explicitly allows dry-run evidence.
- Do not open public managed access until every P0 domain and one staged launch rehearsal pass, topology preflight and
  merge are accepted-ready, the public summary validates, and the final audit emits the open-access handoff args.

## Private Workflow

Create the private workspace from `takos-private`:

```bash
cd ../takos-private
bun run managed-offering:workspace -- --environment staging --date YYYY-MM-DD
```

The workspace task writes ignored `.managed-readiness/<env>/` artifacts:

- `rehearsal-YYYY-MM-DD.json`
- `production-topology-staging-YYYY-MM-DD.json`
- `production-topology-production-YYYY-MM-DD.json`
- `operator-handoff-YYYY-MM-DD.json`
- paths for topology preflight, merge, public summary, and live audit outputs

Fill placeholders only with live operator evidence, then validate:

```bash
cd ../takos-private
bun run managed-offering:validate -- --environment staging --date YYYY-MM-DD
```

The wrapper delegates to `takosumi launch-readiness validate --file <json>`. The validator fails closed until all
P0 domain rows and all staged rehearsal steps have status, owner, reviewer, environment, valid timestamps, required
evidence types, private refs, summaries, and public-safe redactions. Owner and reviewer must be different.

## Production Topology Evidence

Topology evidence is checked separately for staging and production, then merged into the readiness bundle:

```bash
cd ../takos-private
bun run managed-offering:topology:preflight -- \
  --environment staging \
  --topology-environment staging \
  --date YYYY-MM-DD

bun run managed-offering:topology:preflight -- \
  --environment staging \
  --topology-environment production \
  --date YYYY-MM-DD

bun run managed-offering:topology:merge -- --environment staging --date YYYY-MM-DD
```

The source topology files must include non-placeholder owner, reviewer, completion time, manifest ref, migration
transcript ref, TLS evidence ref, artifact digest evidence ref, health probe evidence ref, rollback target ref and
digest, per-component health probes, deployable component artifact digests, and Accounts rendered-config validation.

For the Cloudflare distribution, Accounts must remain Worker-only for this topology evidence:

- `runtime: "cloudflare-worker"`
- `containerRuntime: false`
- `D1:TAKOSUMI_ACCOUNTS_DB`
- `R2:TAKOSUMI_ACCOUNTS_EXPORTS`
- no container or Durable Object persistence substitution for the Accounts component

Workers.dev bootstrap is not enough. Launch topology requires custom-domain DNS/TLS and health/OIDC evidence for the
public hostname:

```bash
cd ../takosumi
bun run deploy:accounts-cloudflare:validate-config
bun run deploy:accounts-cloudflare:dryrun
CLOUDFLARE_API_TOKEN=<zone-dns-token> bun run deploy:accounts-cloudflare:ensure-dns -- \
  --target "${TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME:?set-workers-dev-hostname}" \
  --check --fail-on-not-ready
bun run deploy:accounts-cloudflare:probe -- \
  --workers-dev-url "${TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL:?set-workers-dev-url}" \
  --custom-domain-url https://accounts.takosumi.com \
  --expected-issuer https://accounts.takosumi.com \
  --fail-on-not-ready
```

The resulting private artifacts are referenced from the topology bundle. Do not copy provider IDs or auth-bearing logs
into public docs.

## Public Summary

After the private readiness bundle validates, generate the public-safe summary from `takos-private`:

```bash
cd ../takos-private
bun run managed-offering:public-summary -- \
  --environment staging \
  --date YYYY-MM-DD \
  --evidence-ref vault://managed-readiness/staging/rehearsal-YYYY-MM-DD.json \
  --public-summary "P0 evidence and one staged launch rehearsal passed; operator approval remains separate."

bun run managed-offering:public-summary:validate -- --environment staging --date YYYY-MM-DD
```

The summary must include the canonical evidence digest and omit raw tenant data, secrets, provider account IDs, Stripe
IDs, legal drafts, support mailbox content, and auth-bearing logs.

## Final Launch Audit

The final audit is the last local command before opening public managed access:

```bash
cd ../takos-private
bun run managed-offering:audit -- \
  --environment staging \
  --date YYYY-MM-DD \
  --evidence-ref vault://managed-readiness/staging/rehearsal-YYYY-MM-DD.json \
  --approval-ref approval://managed-readiness/staging/operator-approval-YYYY-MM-DD.json
```

The audit validates the readiness bundle and public summary, dry-runs `takosumi accounts serve
--managed-offering-access open` with the same digest, private evidence ref, separate approval ref, and public summary,
and emits `accountsServeManagedOfferingArgs`. Use those args for the real Accounts service configuration; do not
recreate the digest or summary by hand.

Cloudflare Workers use environment variables instead of `accounts serve` argv. Copy the readiness digest, evidence ref,
approval ref, and public summary from the audit output into the corresponding `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_*`
variables only after the audit succeeds.

## Status Command

At any point, render the read-only launch state:

```bash
cd ../takos-private
bun run managed-offering:status -- --environment staging --date YYYY-MM-DD --format markdown
```

`canOpenManagedOffering` must remain `false` until readiness, topology preflight/merge, public summary, operator
handoff, and live audit are all accepted-ready and the saved live audit contains `accountsServeOpenDryRun: true` plus
`accountsServeManagedOfferingArgs`.
