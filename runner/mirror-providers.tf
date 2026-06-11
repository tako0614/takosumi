# Minimal config used ONLY at image-build time to drive `tofu providers mirror`.
# It pins the provider set baked into the offline filesystem mirror
# (/opt/opentofu/provider-mirror). Keep this list in lockstep with the
# filesystem_mirror/direct include+exclude lists in runner/tofu.rc.
#
# aws is mirrored so the first-party `aws-s3-storage` Capsule resolves its
# `hashicorp/aws` provider from disk under offline init (the `direct { exclude }`
# in tofu.rc would otherwise fail-closed the run because aws is on the exclude
# list and unreachable with no network). `aws-s3-storage/module/main.tf` leaves
# `hashicorp/aws` unconstrained, so any mirrored 6.x satisfies it; pinning `~> 6.0`
# here keeps the baked binary deterministic. google is still omitted for size; it
# falls through to `direct` (registry) install until a later phase mirrors it too.
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
    aws = {
      source  = "registry.opentofu.org/hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
