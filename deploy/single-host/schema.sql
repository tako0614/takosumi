create table if not exists takos_paas_documents (
  collection text not null,
  id text not null,
  body_json jsonb not null,
  created_at text not null,
  updated_at text not null,
  primary key (collection, id)
);

create index if not exists takos_paas_documents_collection_updated_idx
  on takos_paas_documents (collection, updated_at, id);
