-- Migration: 20260430000016_custom_domain_reservations
-- Purpose:   Introduce a kernel-side custom domain registry so cross-tenant
--            hostname collisions (e.g. tenant-A and tenant-B both requesting
--            `api.example.com`) are detected before a provider materializer
--            mutates upstream DNS / SSL state.
--
-- Phase:     18  (custom domain cross-tenant collision detection)
-- Domain:    routing / custom-domain-registry

-- ---------------------------------------------------------------------------
-- 1. Reservation table.
--
-- The hostname is the natural primary key; the unique constraint is what
-- gives the registry its atomic "first writer wins" semantics. Status
-- transitions: `pending` (claimed but DNS not yet verified) -> `verified`
-- (provider confirmed) -> `released` (rollback / uninstall).
-- ---------------------------------------------------------------------------

create table if not exists custom_domain_reservations (
  hostname              text        primary key,
  owner_tenant_id       text        not null,
  owner_group_id        text        not null,
  owner_deployment_id   text        not null,
  status                text        not null
    check (status in ('pending','verified','released')),
  reserved_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists custom_domain_reservations_owner_idx
  on custom_domain_reservations (owner_tenant_id, owner_group_id);

create index if not exists custom_domain_reservations_deployment_idx
  on custom_domain_reservations (owner_deployment_id);

create index if not exists custom_domain_reservations_status_idx
  on custom_domain_reservations (status);
