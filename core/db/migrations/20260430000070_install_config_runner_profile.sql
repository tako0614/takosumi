-- Migration: 20260430000070_install_config_runner_profile
update takosumi_install_configs
set config_json = config_json || jsonb_build_object('runnerId', 'opentofu-default')
where config_json ->> 'runnerId' in (
  'cloudflare-default',
  'aws-provider-env-candidate',
  'gcp-provider-env-candidate',
  'azure-provider-env-candidate',
  'kubernetes-provider-env-candidate',
  'github-provider-env-candidate',
  'digitalocean-provider-env-candidate',
  'hcloud-provider-env-candidate',
  'vultr-provider-env-candidate',
  'scaleway-provider-env-candidate',
  'openstack-provider-env-candidate',
  'docker-custom-example',
  'generic-opentofu-provider'
);
