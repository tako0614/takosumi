-- Migration: 20260430000065_capsules_active_name_unique
drop index if exists takosumi_capsules_space_name_environment_unique;
drop index if exists takosumi_opentofu_installations_space_name_environment_unique;
create unique index if not exists takosumi_capsules_space_name_environment_active_unique
  on takosumi_capsules (space_id, name, environment)
  where status <> 'destroyed';
