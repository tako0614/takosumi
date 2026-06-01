create table if not exists takosumi_documents (
  collection text not null,
  id text not null,
  body_json jsonb not null,
  created_at text not null,
  updated_at text not null,
  primary key (collection, id)
);

create index if not exists takosumi_documents_collection_updated_idx
  on takosumi_documents (collection, updated_at, id);
