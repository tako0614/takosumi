# Takosumi Cloud Dashboard UX Redesign

Last updated: 2026-06-21

This document is the product UX redesign plan for Takosumi Cloud. It does not
replace the Takosumi Final Plan. The Final Plan defines the system model:
Workspace / Project / Capsule / ProviderConnection / CredentialRecipe /
ProviderBinding / Run / StateVersion / Output / AuditEvent. This document
defines how Takosumi Cloud should present that model to ordinary hosted-service
users.

## 1. Problem

The current dashboard is too close to the control-plane implementation.

It exposes terms and screens that are useful for operators and developers:

- Workspace
- Capsule
- ProviderConnection
- Run
- State generation
- Output shares
- Provider alias
- policy JSON
- dependency graph
- raw activity/audit style feeds

Those concepts are valid internally, and advanced users must still be able to
inspect them. But they should not be the primary Takosumi Cloud experience.

Takosumi Cloud is not mainly a developer console. The buyer-facing job is:

```text
Choose software.
Connect the external accounts it needs.
Host it under my ownership.
Open it, update it, pause it, delete it, and understand billing.
```

The current UI answers:

```text
Which OpenTofu Capsule and ProviderConnection produced which Run and Output?
```

That is a lower-level answer than the user needs.

## 2. Product Position

Takosumi OSS remains an OpenTofu/Terraform control plane. Takosumi Cloud is the
official hosted operator deployment plus cloud-only services.

The Cloud dashboard must be framed as:

```text
Personal software hosting.
```

Not:

```text
Terraform run management.
```

Not:

```text
Cloud provider abstraction dashboard.
```

Not:

```text
App store that hides ownership.
```

The user still owns the resources and connections. Takosumi Cloud makes the path
ordinary and reversible.

## 3. UX Principle

Use two layers.

### Layer A: Normal User Layer

Default, always first.

Vocabulary:

| Internal model         | Normal UI label                            |
| ---------------------- | ------------------------------------------ |
| Workspace              | Personal space / Team, only when needed    |
| Project                | Service group, usually hidden              |
| Capsule / Installation | Service                                    |
| Source                 | Source                                     |
| ProviderConnection     | Connection                                 |
| CredentialRecipe       | Connection method, hidden                  |
| ProviderBinding        | Which connection this service uses, hidden |
| Run / Plan / Apply     | Review / Deploy                            |
| StateVersion           | Restore point                              |
| Output                 | Address / value                            |
| Output share           | Shared value, advanced                     |
| AuditEvent             | Activity, advanced when raw                |

The normal layer should answer:

- What services do I have?
- Which ones are live?
- Which one needs attention?
- How do I add another one?
- What account is it using?
- What will it cost?
- Where do I open it?
- How do I update, pause, restore, or delete it?

### Layer B: Advanced / Developer Layer

Accessible, but not primary.

Use an explicit switch or section:

```text
Advanced details
```

It contains:

- Capsule ID
- source Git URL / ref / path
- OpenTofu provider list
- Provider binding table
- raw Run history
- state generations
- outputs JSON
- dependency graph
- audit event details
- policy JSON
- plan artifact IDs

Advanced details should never block the ordinary user's first successful deploy
unless there is a real decision to make.

## 4. Information Architecture

### 4.1 Global Navigation

Desktop:

```text
Services
Add
Connections
Billing
Activity
Account
```

Mobile bottom tabs:

```text
Services
Add
Alerts
Account
```

Rules:

- Do not show `Workspace settings` as a primary destination for single-user
  accounts.
- Do not show `Output shares`, `Dependency graph`, or `Runs` in primary nav.
- Only show a space/team switcher when the user actually has more than one
  space/team.
- Keep Docs as a help link, not a primary product tab.

### 4.2 Home: Services

The home screen is a service launcher and health surface.

It should show:

- service name
- icon/category
- live / deploying / needs setup / failed / paused
- primary action: Open, Continue setup, Review change, Fix
- public address when available
- small provider badges only when useful, such as Cloudflare or AWS

It should not show by default:

- Capsule
- Run
- State generation
- provider alias
- source ref
- deployment generation
- output JSON

Empty state:

```text
Host your first service

Choose a starter or paste a source link. Takosumi will show what it needs before
anything is deployed.
```

Primary buttons:

```text
Browse starters
Import from source
```

### 4.3 Add: Host Software

This is not a raw Git form first.

Default tabs:

```text
Starters
From a link
From Git
```

`Starters` contains curated deployable software, not internal templates that
only exist as smoke fixtures.

Each card must state:

- what it hosts
- what account it needs
- whether it creates a public URL
- estimated cost/quota class
- whether it can be deleted cleanly

Example:

```text
Takos
Self-hostable AI workspace.
Needs: Cloudflare account
Creates: Worker, D1, KV, R2, Queue, container
You can review every resource before deploy.
```

`From Git` stays available, but it is the power path. It should say:

```text
Use a Git repository that contains an OpenTofu/Terraform module.
```

It should not be the first impression of Takosumi Cloud.

### 4.4 Install Flow

Use a single guided flow:

```text
1. Choose software
2. Connect accounts
3. Review resources
4. Deploy
5. Open
```

Each step has a normal explanation and a collapsed technical section.

#### Step 1: Choose Software

Show:

- name
- source owner
- selected version
- short description
- required connections

Hide:

- Capsule compatibility diagnostics unless there is an issue
- source snapshot IDs
- plan/run IDs

#### Step 2: Connect Accounts

Use provider-specific cards:

```text
Connect Cloudflare
Used to create Workers, storage, databases, and routes in your account.
```

Preferred methods:

- OAuth where available
- guided token creation where OAuth is not available
- manual token input as fallback

The user should not have to understand ProviderConnection, CredentialRecipe, or
ProviderBinding to continue.

#### Step 3: Review Resources

Show a human-readable summary first:

```text
Takosumi will create:
- 1 Worker
- 1 database
- 2 storage buckets
- 1 queue
```

Show risk markers:

- creates new resources
- may replace existing resource
- may delete data
- requires paid provider features

Advanced section:

- OpenTofu plan
- provider list
- state scope
- resource addresses

#### Step 4: Deploy

Show a progress timeline:

```text
Preparing source
Checking account access
Creating resources
Saving restore point
Publishing service
```

Do not show raw logs by default. Provide:

```text
Show technical log
```

#### Step 5: Open

Successful finish screen:

```text
Takos is ready
Open service
Copy address
View settings
```

If no public URL exists:

```text
This service was deployed, but it does not expose a public screen yet.
```

Then show why:

- background-only service
- route/domain not configured
- waiting for DNS
- another service needs to be connected

## 5. Service Detail

Default tabs:

```text
Overview
Settings
Updates
Backups
Advanced
```

### Overview

Should show:

- open button
- current status
- what this service does
- connected accounts
- recent meaningful updates
- public addresses
- next useful action

Should not show:

- Capsule ID
- state generation
- deployment ID
- source snapshot ID
- provider alias table

### Settings

Normal settings:

- name
- public address/domain
- environment variables that are safe to show
- connected account selection
- pause/delete

Advanced connection changes should be behind confirmation.

### Updates

User-facing update flow:

```text
Check for updates
Review update
Deploy update
```

The raw plan is available under advanced details.

### Backups

Use ordinary language:

```text
Restore points
```

Not:

```text
StateVersion
```

### Advanced

Contains:

- Source
- Capsule
- Runs
- State
- Outputs
- Provider bindings
- Audit log

This can be dense and operator-friendly.

## 6. Connections

Connections must be a guided account-linking area, not a credential table.

Default cards:

```text
Cloudflare
Google Cloud
AWS
Hetzner
DigitalOcean
Generic environment variables
```

Each card has:

- Connect
- status
- used by which services
- rotate/remove

Manual credential entry is allowed, but should be introduced as:

```text
Paste a token from Cloudflare
```

Not:

```text
Create ProviderConnection
```

## 7. Billing

Billing must answer:

- Is billing enabled?
- What plan am I on?
- What is included?
- What did my services consume?
- What will stop if payment fails?

When billing is disabled, do not show broken checkout/portal affordances. Say:

```text
Billing is not enabled for this deployment.
```

When billing is manual/showback:

```text
Usage is being recorded, but deployments are not blocked by payment status.
```

When billing is enforced:

```text
Deployments require an active plan or credit balance.
```

## 8. Mobile Requirements

Mobile is not a compressed desktop console.

Rules:

- Bottom nav only has the four core destinations.
- No wide tables.
- Forms are one decision per screen where possible.
- Advanced details are collapsed by default.
- Long technical values use copy buttons and truncation.
- Service cards must fit without horizontal scrolling.
- The install flow uses a sticky bottom action bar.

The current mobile problem is especially visible in Workspace settings, where
advanced items such as output sharing are reachable as normal tabs. That must
move behind Advanced.

## 9. Visual Direction

The Takosumi ink design can remain on the marketing/intro pages.

The signed-in Cloud app should be quieter:

- simple surfaces
- strong hierarchy
- fewer decorative treatments
- clear status colors
- compact but readable cards
- dark mode and light mode
- no hero-style treatment inside the product app
- no large explanatory marketing copy after sign-in

The product app should feel like a hosting control app for normal people, not a
Terraform dashboard and not a marketing site.

## 10. Route Plan

Target routes:

```text
/                         Services
/add                      Add / host software
/services/:id             Service detail
/services/:id/settings
/services/:id/updates
/services/:id/backups
/services/:id/advanced
/connections              Connected accounts
/billing                  Billing
/activity                 Human activity
/account                  Account
/advanced/runs/:id        Technical run detail
/advanced/graph           Dependency graph
/advanced/workspace       Workspace advanced settings
```

Compatibility redirects:

```text
/new                       -> /add
/capsules                  -> /
/capsules/:id              -> /services/:id/advanced or /services/:id
/runs/:id                  -> /advanced/runs/:id
/workspace/settings        -> /advanced/workspace
/workspace/settings/shares -> /advanced/workspace/shares
```

Do not break existing external install links:

```text
/install?git=...
```

They should land in `/add` with the selected source already loaded.

## 11. Implementation Phases

### Phase 1: Vocabulary and Navigation

- Replace primary copy `Capsule` with `Service` in normal UI.
- Move `Workspace settings` out of primary nav.
- Add `/connections` and `/billing` first-class routes.
- Add `/advanced/*` route group for current technical screens.
- Keep old routes as redirects.

### Phase 2: Service-First Home

- Redesign home around service cards and next actions.
- Remove dependency graph from primary actions.
- Hide run/state identifiers.
- Show `Continue setup`, `Review change`, `Open`, and `Fix` as the primary row
  actions.

### Phase 3: Add Flow

- Rename `/new` conceptually to `/add`.
- Make `Starters` and external install links first-class.
- Move raw Git source form to `From Git`.
- Add a deployable starter policy: a starter card must be runnable from
  Takosumi alone.

### Phase 4: Connection Wizard

- Replace credential-table-first UI with provider cards.
- Add OAuth/guided token/manual token modes.
- Show where each connection is used.
- Keep advanced ProviderConnection details under expandable sections.

### Phase 5: Review and Deploy

- Replace run-first screens with human review screens.
- Keep raw OpenTofu plan/logs behind `Show technical details`.
- Make failure states actionable.

### Phase 6: Advanced Area

- Move output shares, raw runs, dependency graph, policy JSON, state generation,
  output JSON, and provider binding tables to Advanced.
- Make Advanced discoverable from service detail and account menu, not global
  first-level navigation.

### Phase 7: Browser GA Evidence

Record mobile and desktop browser evidence for:

- sign in with Google
- host from Takos website install link
- host from starter
- connect Cloudflare
- review resources
- deploy
- open service
- failed connection recovery
- billing disabled/manual/enforced modes
- dark mode and light mode
- mobile install flow

## 12. Acceptance Criteria

Takosumi Cloud is not UX-ready until a non-developer can complete this without
learning the internal model:

```text
1. Open takos.jp.
2. Click the install/host CTA.
3. Sign in with Google.
4. See what will be hosted.
5. Connect the required cloud account.
6. Review a clear resource summary.
7. Deploy.
8. Open the hosted service.
9. Find billing and delete/restore controls.
```

Allowed technical escape hatches:

- Show OpenTofu plan
- Show logs
- Show provider bindings
- Show state/output/audit

But those are escape hatches, not the product's first language.

## 13. Non-Negotiables

- Do not remove OpenTofu/Terraform truth.
- Do not hide destructive changes.
- Do not fake one-click deploy when provider credentials or billing are missing.
- Do not make Git URL the only happy path.
- Do not expose Cloud-only Gateway features in OSS Takosumi as normal OSS
  features.
- Do not ship starters that cannot actually plan/apply through Takosumi.
- Do not use `Capsule`, `ProviderConnection`, `StateVersion`, or `Output share`
  as primary Cloud UI nouns.

## 14. Current Diagnosis

The current dashboard has useful pieces:

- Google sign-in only is aligned with the current product direction.
- Service list already uses `Services` in some places.
- `/install?git=...` correctly pre-fills instead of auto-deploying.
- ProviderConnection and run ledger machinery exist.
- `cloudflare-hello-worker` proves an internal starter path.

The current dashboard is still not consumer-ready:

- primary nav exposes Workspace settings;
- mobile settings exposes output sharing as a normal tab;
- `Capsule` is still visible in normal copy;
- service detail still leads with deployment/control-plane concepts;
- Add flow is still Git/source/control-plane shaped;
- public examples are not enough to prove a normal deployable software journey;
- technical details are mixed into first-level screens instead of grouped under
  Advanced.

The redesign should start by changing the information architecture, not only by
polishing CSS.
