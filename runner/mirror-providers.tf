# Minimal config used ONLY at image-build time to drive `tofu providers mirror`.
# It pins the provider set baked into the offline filesystem mirror
# (/opt/opentofu/provider-mirror). Keep this list in lockstep with the
# filesystem_mirror/direct include+exclude lists in runner/tofu.rc.
#
# Pin exact provider versions here. The runner's tofu.rc excludes these providers
# from direct registry installs, so a source lockfile that selects a version not
# baked into the mirror fail-closes during credential-free `tofu init`.
#
# Cloudflare is pinned to 5.19.1 because the GA Takos install Capsule lockfile
# currently selects that version. Do not loosen this to `~> 5.0`: `tofu providers
# mirror` would bake only the latest 5.x provider and older reviewed lockfiles
# would stop installing in the runner image.
#
# Generic AWS/S3/GCS stacks install through the ordinary provider install/cache
# path. google is still omitted for size; it falls through to `direct`
# (registry) install until a later phase mirrors it too.
terraform {
  required_providers {
    cloudflare = {
      source  = "registry.opentofu.org/cloudflare/cloudflare"
      version = "= 5.19.1"
    }
    random = {
      source  = "registry.opentofu.org/hashicorp/random"
      version = "= 3.9.0"
    }
    tls = {
      source  = "registry.opentofu.org/hashicorp/tls"
      version = "= 4.3.0"
    }
  }
}
