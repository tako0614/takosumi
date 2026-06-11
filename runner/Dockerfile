FROM oven/bun:1

# OpenTofu 1.11.x. Pinned to the latest 1.11 patch at image-build time; the
# download URL shape is the published GitHub release asset
# tofu_${VERSION}_linux_amd64.zip.
ARG OPENTOFU_VERSION=1.11.8

# Source-sync (LANE M1) needs git + openssh-client to clone over https/ssh and
# zstd to compress the deterministic source archive. tar is in the debian base.
# ca-certificates + git + curl + unzip were already required by OpenTofu install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip openssh-client zstd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
    "https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/tofu_${OPENTOFU_VERSION}_linux_amd64.zip" \
    -o /tmp/tofu.zip \
    && unzip /tmp/tofu.zip -d /usr/local/bin \
    && rm /tmp/tofu.zip \
    && tofu version

# ---------------------------------------------------------------------------
# Provider mirror (baked, offline plan/apply).
#
# Pre-mirror the provider set the bundled first-party modules need into a filesystem
# mirror so `tofu init` resolves providers from disk with NO network round-trip
# to registry.opentofu.org. The baked tofu.rc (TF_CLI_CONFIG_FILE) wires a
# plugin_cache_dir + a provider_installation block whose filesystem_mirror is
# authoritative for the mirrored providers and `direct { exclude=[...] }`
# forbids reaching the network for exactly those providers.
#
# Mirror list covers the providers the bundled first-party modules require:
# cloudflare + random + tls for the Cloudflare modules, and aws for the
# `aws-s3-storage` Capsule (without it that Capsule fail-closes under offline
# init because tofu.rc excludes aws from `direct`). The aws provider binary is
# large, so this layer is the dominant build-time/image-size cost. google is
# still omitted for size; it falls through to `direct` (network) install unless
# a strict mirror policy blocks the run.
# ---------------------------------------------------------------------------
ENV OPENTOFU_PROVIDER_MIRROR=/opt/opentofu/provider-mirror
ENV OPENTOFU_PROVIDER_CACHE=/opt/opentofu/provider-cache
ENV TF_CLI_CONFIG_FILE=/opt/opentofu/tofu.rc

# The baked CLI config. plugin_cache_dir speeds warm re-inits; the
# provider_installation filesystem_mirror serves the mirrored providers from
# disk and `direct { exclude }` keeps tofu from going to the network for them.
COPY runner/tofu.rc ${TF_CLI_CONFIG_FILE}

# Minimal build-time config that pins the provider set to mirror. Lives in its
# own dir so `tofu providers mirror` resolves only this config.
COPY runner/mirror-providers.tf /opt/opentofu/mirror-build/providers.tf

RUN set -eux; \
    mkdir -p "${OPENTOFU_PROVIDER_MIRROR}" "${OPENTOFU_PROVIDER_CACHE}"; \
    # `tofu providers mirror` must NOT use the baked filesystem-mirror config
    # (it is what populates that mirror); run it with an empty CLI config so it
    # talks to the registry directly.
    env -u TF_CLI_CONFIG_FILE tofu -chdir=/opt/opentofu/mirror-build \
        providers mirror "${OPENTOFU_PROVIDER_MIRROR}"; \
    rm -rf /opt/opentofu/mirror-build; \
    ls -R "${OPENTOFU_PROVIDER_MIRROR}" | head -40

# Bundled first-party Capsule modules baked into a flat in-image layout
# (templates/<id>/module + template.ts metadata; the .ts files are inert in the
# image). The provider-agnostic `core` module lives under `opentofu-modules/`;
# the provider-specific modules live under `providers/<provider>/modules/<id>/`.
# Each is copied to `/app/templates/<id>/` so `template.localModulePath` (e.g.
# /app/templates/cloudflare-r2-storage/module) stays a stable in-image path; the
# runner copies it to /work/generated-root/template-module at plan/apply time.
# Template-less Capsule runs copy their SourceSnapshot/normalized module into the
# same generated-root child-module slot.
WORKDIR /app
COPY opentofu-modules/core/ ./templates/core/
COPY providers/cloudflare/modules/cloudflare-r2-storage/ ./templates/cloudflare-r2-storage/
COPY providers/cloudflare/modules/cloudflare-static-site/ ./templates/cloudflare-static-site/
COPY providers/cloudflare/modules/cloudflare-worker-service/ ./templates/cloudflare-worker-service/
COPY providers/aws/modules/aws-s3-storage/ ./templates/aws-s3-storage/

# The runner server imports the dependency-free shared provider->env-name table
# from the contract layer via a relative path. The build context is the repo root
# (image_build_context = "../.."), so we copy both files preserving the
# entrypoint.ts -> ../contract/provider-env-rules.ts relative layout. No
# other repo source (or the Worker browser bundle) is copied into the image.
COPY contract/provider-env-rules.ts ./contract/provider-env-rules.ts
COPY contract/reference/ip-classification.ts ./contract/reference/ip-classification.ts
COPY contract/reference/host-blocklist.ts ./contract/reference/host-blocklist.ts
COPY runner/entrypoint.ts ./runner/entrypoint.ts

ENV PORT=8080
ENV TOFU_WORK_DIR=/workspace

EXPOSE 8080
CMD ["bun", "run", "./runner/entrypoint.ts"]
