-- Migration: 20260430000025_catalog_releases
create table if not exists registry_catalog_publisher_keys (
  key_id            text        primary key,
  publisher_id      text        not null,
  public_key_base64 text        not null,
  status            text        not null
    check (status in ('active','revoked')),
  enrolled_at       timestamptz not null,
  revoked_at        timestamptz,
  reason            text
);
create index if not exists registry_catalog_publisher_keys_publisher_idx
  on registry_catalog_publisher_keys (publisher_id);
create index if not exists registry_catalog_publisher_keys_status_idx
  on registry_catalog_publisher_keys (status);
create table if not exists registry_catalog_releases (
  release_id          text        primary key,
  publisher_id        text        not null,
  descriptor_digest   text        not null,
  descriptor_json     jsonb       not null,
  signature_algorithm text        not null,
  signature_key_id    text        not null,
  signature_value     text        not null,
  created_at          timestamptz not null,
  activated_at        timestamptz
);
create index if not exists registry_catalog_releases_publisher_idx
  on registry_catalog_releases (publisher_id);
create index if not exists registry_catalog_releases_digest_idx
  on registry_catalog_releases (descriptor_digest);
create index if not exists registry_catalog_releases_created_at_idx
  on registry_catalog_releases (created_at);
create table if not exists registry_catalog_release_adoptions (
  id                               text        primary key,
  space_id                         text        not null,
  catalog_release_id               text        not null
    references registry_catalog_releases(release_id),
  publisher_id                     text        not null,
  publisher_key_id                 text        not null
    references registry_catalog_publisher_keys(key_id),
  descriptor_digest                text        not null,
  adopted_at                       timestamptz not null,
  rotated_from_catalog_release_id  text,
  verification_json                jsonb       not null,
  unique (space_id, catalog_release_id)
);
create index if not exists registry_catalog_release_adoptions_space_idx
  on registry_catalog_release_adoptions (space_id, adopted_at);
create index if not exists registry_catalog_release_adoptions_release_idx
  on registry_catalog_release_adoptions (catalog_release_id);
create index if not exists registry_catalog_release_adoptions_key_idx
  on registry_catalog_release_adoptions (publisher_key_id);
