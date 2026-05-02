-- Migration: 20260430000015_service_endpoints
-- Purpose:   Create service endpoint, trust-record, and grant tables
--            referenced by the service endpoint storage statement catalog.
-- Domain:    service-endpoints

create table if not exists service_endpoints (
  id            text        primary key,
  service_id    text        not null,
  space_id      text        not null,
  group_id      text        not null,
  endpoint_json jsonb       not null,
  updated_at    timestamptz not null
);
create index if not exists service_endpoints_service_idx
  on service_endpoints (service_id);
create index if not exists service_endpoints_group_idx
  on service_endpoints (space_id, group_id);

create table if not exists service_trust_records (
  id                text        primary key,
  endpoint_id       text        not null references service_endpoints(id),
  trust_record_json jsonb       not null,
  updated_at        timestamptz not null
);
create index if not exists service_trust_records_endpoint_idx
  on service_trust_records (endpoint_id);

create table if not exists service_grants (
  id              text  primary key,
  trust_record_id text  not null references service_trust_records(id),
  subject         text  not null,
  grant_json      jsonb not null
);
create index if not exists service_grants_trust_record_idx
  on service_grants (trust_record_id);
create index if not exists service_grants_subject_idx
  on service_grants (subject);
