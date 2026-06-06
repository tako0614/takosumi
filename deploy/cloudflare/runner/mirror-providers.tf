# Minimal config used ONLY at image-build time to drive `tofu providers mirror`.
# It pins the provider set baked into the offline filesystem mirror
# (/opt/opentofu/provider-mirror). Keep this list in lockstep with the
# filesystem_mirror/direct include+exclude lists in runner/tofu.rc.
#
# aws/google are intentionally omitted for size; they fall through to `direct`
# (registry) install until a later phase mirrors them too.
terraform {
  required_providers {
    cloudflare = {
      source  = "registry.opentofu.org/cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source = "registry.opentofu.org/hashicorp/random"
    }
    tls = {
      source = "registry.opentofu.org/hashicorp/tls"
    }
  }
}
