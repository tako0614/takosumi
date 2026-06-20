-- Migration: 20260430000050_provider_materialization_values
update takosumi_provider_catalog
  set primary_materialization = case
    when primary_materialization in ('takosumi_managed','gateway') then 'secret'
    when primary_materialization = 'user_env_set' then 'secret'
    when primary_materialization in ('oauth','secret') then primary_materialization
    else 'secret'
  end
  where primary_materialization not in ('oauth','secret')
     or primary_materialization = 'gateway';
delete from takosumi_provider_envs
  where space_id is null;
alter table takosumi_provider_envs
  alter column space_id set not null;
update takosumi_provider_envs
  set materialization = case
    when materialization in ('takosumi_managed','user_env_set','gateway') then 'secret'
    when materialization in ('oauth','secret') then materialization
    else 'secret'
  end
  where materialization not in ('oauth','secret')
     or materialization = 'gateway';
alter table takosumi_provider_catalog
  drop constraint if exists takosumi_provider_catalog_primary_materialization_check;
alter table takosumi_provider_catalog
  add constraint takosumi_provider_catalog_primary_materialization_check
  check (primary_materialization in ('oauth','secret'));
alter table takosumi_provider_envs
  drop constraint if exists takosumi_provider_envs_materialization_check;
alter table takosumi_provider_envs
  add constraint takosumi_provider_envs_materialization_check
  check (materialization in ('oauth','secret'));
alter table takosumi_provider_envs
  drop constraint if exists takosumi_provider_envs_global_materialization_check;
alter table takosumi_provider_envs
  add constraint takosumi_provider_envs_global_materialization_check
  check (space_id is not null);
