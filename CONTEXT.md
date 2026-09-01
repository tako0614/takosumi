# Takosumi domain context

This glossary is deliberately limited to domain meaning. It does not describe
source files, routes, persistence, deployment configuration, or implementation
history.

## Stack

A Stack is a user's plain OpenTofu or Terraform module together with its source,
provider configuration, and inputs. A Stack is the unit that Takosumi plans,
applies, refreshes, or destroys. The module and its provider graph decide what
the Stack means; Takosumi does not add a second desired-state language.

## BYOC

BYOC (Bring Your Own Cloud) is the customer-owned supply mode. The Workspace or
customer owns the vendor account and credential. Takosumi uses that authority
for an approved Stack Run, and the selected standard provider calls the vendor
directly. Takoserver is not part of a BYOC path.

## ProviderConnection

A ProviderConnection is a Workspace/customer-owned reference to a vendor account
credential configuration. It identifies which customer-controlled authority a
Run may use without exposing the credential value as ordinary Stack data.

## CredentialRecipe

A CredentialRecipe describes how an authorized ProviderConnection becomes
short-lived, run-scoped provider material, such as an environment value or
file. It describes materialization; it is not a vendor account or a provider
selection.

## ProviderBinding

A ProviderBinding connects a provider name or alias in a Stack to one explicit
ProviderConnection and its CredentialRecipe. It is the authorization choice
for a Run, not a catalog lookup or a managed-capacity selection.

## RunAuthority

RunAuthority is the authority for a Stack lifecycle operation. It owns the
meaning of plan, apply, destroy, refresh, review, lease, audit, mutation fence,
and reconciliation of a typed indeterminate result. It decides whether one
immutable Run may be dispatched and whether a later observation may adopt that
Run's exact result.

## Executor

An Executor receives one immutable, already-authorized Run envelope. It runs
the approved OpenTofu phase, uses only the scoped material granted to that Run,
and returns either a terminal result with immutable artifacts or a typed
indeterminate outcome. It is not the authority that approves, schedules,
retries, or adopts a Run.

## Managed Host resource

A managed Host resource is a service a Host operator supplies and operates for
customers. The Host owns the provider account, credential, capacity, placement,
native identity, lifecycle, support, and commercial terms. A customer consumes
the Host's contract; the customer does not turn the Host's parent credential
into BYOC.

## Takoserver Host

Takoserver Host is the external Takoform Host that provides optional managed
supply. Takoserver owns the managed-service Offering, Resource and Deployment
lifecycle, provider installation and backend, capacity, placement, Workers for
Platforms namespace and dispatcher where required, provider receipts, and
support/commercial authority. Takosumi may run an ordinary Takoform provider
with a Host-scoped credential, but it never selects or receives Takoserver's
parent provider credential, installation, backend, capacity, namespace,
dispatcher, or native identity.

## Migration custody

Migration custody is temporary authority to read, reconcile, export, or delete
retained records from a superseded model. It does not make the old model a
supported authoring flow, create a new lifecycle owner, or transfer customer or
Host authority. Migration must use exact identities, authenticated scope,
bounded work, durable evidence, and a recoverable backup/restore plan.
