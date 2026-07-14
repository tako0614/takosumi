# Minimal config used ONLY at image-build time to drive `tofu providers mirror`.
# It pins one reference-image cache baked into the filesystem mirror
# (/opt/opentofu/provider-mirror). This file controls image contents only; it is
# not a Takosumi provider catalog or an execution allowlist.
#
# Pin exact provider versions here so a matching source lockfile can reuse the
# cache. Mirror-only execution is an explicit per-run policy and fail-closes via
# the generated strict CLI config, independently of this reference cache list.
#
# Versions in this reference cache are exact so reviewed lockfiles can reuse
# them deterministically. Do not loosen them to ranges: `tofu providers mirror`
# would bake only the latest matching provider and older reviewed lockfiles
# would stop installing in the runner image. Operators can replace or extend
# this image cache without changing provider admission or Capsule semantics.
#
# Any provider not present in this image cache uses the ordinary provider
# install/cache path unless an operator selects mirror-only execution.
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
    http = {
      source  = "registry.opentofu.org/hashicorp/http"
      version = "= 3.6.0"
    }
  }
}
