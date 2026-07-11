-- Migration: 20260430000067_install_config_store_key
-- Purpose:   Converge pre-v1 InstallConfig JSON onto the canonical `store`
--            presentation metadata key. The retired `catalog` key is removed;
--            no runtime compatibility branch remains after migration.

update takosumi_install_configs
set config_json = case
  when config_json ? 'store' then config_json - 'catalog'
  else (config_json - 'catalog') || jsonb_build_object('store', config_json -> 'catalog')
end
where config_json ? 'catalog';
